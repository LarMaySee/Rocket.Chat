import moment from 'moment-timezone';
import { ILivechatAgentStatus } from '@rocket.chat/core-typings';
import type { ILivechatBusinessHour, ILivechatDepartment } from '@rocket.chat/core-typings';
import type { ILivechatBusinessHoursModel, IUsersModel } from '@rocket.chat/model-typings';
import { LivechatBusinessHours, Users } from '@rocket.chat/models';
import type { UpdateFilter } from 'mongodb';

import type { IWorkHoursCronJobsWrapper } from '../../../../server/models/raw/LivechatBusinessHours';
import { businessHourLogger } from '../lib/logger';
import { filterBusinessHoursThatMustBeOpened } from './Helper';

export interface IBusinessHourBehavior {
	findHoursToCreateJobs(): Promise<IWorkHoursCronJobsWrapper[]>;
	openBusinessHoursByDayAndHour(day: string, hour: string): Promise<void>;
	closeBusinessHoursByDayAndHour(day: string, hour: string): Promise<void>;
	onDisableBusinessHours(): Promise<void>;
	onAddAgentToDepartment(options?: { departmentId: string; agentsId: string[] }): Promise<any>;
	onRemoveAgentFromDepartment(options?: Record<string, any>): Promise<any>;
	onRemoveDepartment(department?: ILivechatDepartment): Promise<any>;
	onStartBusinessHours(): Promise<void>;
	afterSaveBusinessHours(businessHourData: ILivechatBusinessHour): Promise<void>;
	allowAgentChangeServiceStatus(agentId: string): Promise<boolean>;
	changeAgentActiveStatus(agentId: string, status: string): Promise<any>;
	// If a new agent is created, this callback will be called
	onNewAgentCreated(agentId: string): Promise<void>;
}

export interface IBusinessHourType {
	name: string;
	getBusinessHour(id?: string): Promise<ILivechatBusinessHour | null>;
	saveBusinessHour(businessHourData: ILivechatBusinessHour): Promise<ILivechatBusinessHour>;
	removeBusinessHourById(id: string): Promise<void>;
}

export abstract class AbstractBusinessHourBehavior {
	protected BusinessHourRepository: ILivechatBusinessHoursModel = LivechatBusinessHours;

	protected UsersRepository: IUsersModel = Users;

	async findHoursToCreateJobs(): Promise<IWorkHoursCronJobsWrapper[]> {
		return this.BusinessHourRepository.findHoursToScheduleJobs();
	}

	async onDisableBusinessHours(): Promise<void> {
		await this.UsersRepository.removeBusinessHoursFromAllUsers();
	}

	async allowAgentChangeServiceStatus(agentId: string): Promise<boolean> {
		return this.UsersRepository.isAgentWithinBusinessHours(agentId);
	}

	async changeAgentActiveStatus(agentId: string, status: ILivechatAgentStatus): Promise<any> {
		return this.UsersRepository.setLivechatStatusIf(
			agentId,
			status,
			// Why this works: statusDefault is the property set when a user manually changes their status
			// So if it's set to offline, we can be sure the user will be offline after login and we can skip the update
			{ livechatStatusSystemModified: true, statusDefault: { $ne: 'offline' } },
			{ livechatStatusSystemModified: true },
		);
	}

	async onNewAgentCreated(agentId: string): Promise<void> {
		businessHourLogger.debug(`Executing onNewAgentCreated for agentId: ${agentId}`);

		const defaultBusinessHour = await LivechatBusinessHours.findOneDefaultBusinessHour();
		if (!defaultBusinessHour) {
			businessHourLogger.debug(`No default business hour found for agentId: ${agentId}`);
			return;
		}

		const businessHourToOpen = await filterBusinessHoursThatMustBeOpened([defaultBusinessHour]);
		if (!businessHourToOpen.length) {
			businessHourLogger.debug(
				`No business hour to open found for agentId: ${agentId}. Default business hour is closed. Setting agentId: ${agentId} to status: ${ILivechatAgentStatus.NOT_AVAILABLE}`,
			);
			await Users.setLivechatStatus(agentId, ILivechatAgentStatus.NOT_AVAILABLE);
			return;
		}

		await Users.addBusinessHourByAgentIds([agentId], defaultBusinessHour._id);

		businessHourLogger.debug(`Setting agentId: ${agentId} to status: ${ILivechatAgentStatus.AVAILABLE}`);
	}
}

export abstract class AbstractBusinessHourType {
	protected BusinessHourRepository: ILivechatBusinessHoursModel = LivechatBusinessHours;

	protected UsersRepository: IUsersModel = Users;

	protected async baseSaveBusinessHour(businessHourData: ILivechatBusinessHour): Promise<string> {
		businessHourData.active = Boolean(businessHourData.active);
		businessHourData = this.convertWorkHours(businessHourData);
		if (businessHourData._id) {
			await this.BusinessHourRepository.updateOne({ _id: businessHourData._id }, {
				$set: businessHourData,
			} as UpdateFilter<ILivechatBusinessHour>); // TODO: Remove this cast when TypeScript is updated
			return businessHourData._id;
		}
		const { insertedId } = await this.BusinessHourRepository.insertOne(businessHourData);
		return insertedId;
	}

	private convertWorkHours(businessHourData: ILivechatBusinessHour): ILivechatBusinessHour {
		businessHourData.workHours.forEach((hour: any) => {
			const startUtc = moment.tz(`${hour.day}:${hour.start}`, 'dddd:HH:mm', businessHourData.timezone.name).utc();
			const finishUtc = moment.tz(`${hour.day}:${hour.finish}`, 'dddd:HH:mm', businessHourData.timezone.name).utc();

			if (hour.open && finishUtc.isBefore(startUtc)) {
				throw new Error('error-business-hour-finish-time-before-start-time');
			}

			if (hour.open && startUtc.isSame(finishUtc)) {
				throw new Error('error-business-hour-finish-time-equals-start-time');
			}

			hour.start = {
				time: hour.start,
				utc: {
					dayOfWeek: startUtc.clone().format('dddd'),
					time: startUtc.clone().format('HH:mm'),
				},
				cron: {
					dayOfWeek: this.formatDayOfTheWeekFromServerTimezoneAndUtcHour(startUtc, 'dddd'),
					time: this.formatDayOfTheWeekFromServerTimezoneAndUtcHour(startUtc, 'HH:mm'),
				},
			};
			hour.finish = {
				time: hour.finish,
				utc: {
					dayOfWeek: finishUtc.clone().format('dddd'),
					time: finishUtc.clone().format('HH:mm'),
				},
				cron: {
					dayOfWeek: this.formatDayOfTheWeekFromServerTimezoneAndUtcHour(finishUtc, 'dddd'),
					time: this.formatDayOfTheWeekFromServerTimezoneAndUtcHour(finishUtc, 'HH:mm'),
				},
			};
		});
		return businessHourData;
	}

	protected getUTCFromTimezone(timezone?: string): string {
		if (!timezone) {
			return String(moment().utcOffset() / 60);
		}
		return moment.tz(timezone).format('Z');
	}

	private formatDayOfTheWeekFromServerTimezoneAndUtcHour(utc: any, format: string): string {
		return moment(utc.format('dddd:HH:mm'), 'dddd:HH:mm')
			.add(moment().utcOffset() / 60, 'hours')
			.format(format);
	}
}
