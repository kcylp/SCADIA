
export class Notification {
    id: string;
    name: string;
    receiver: string;
    delay = 1;
    interval = 0;
    enabled = true;
    text: string;
    type: string;
    subscriptions = {};
    sceneIds: string[] = ['V1','V2','V3','V4','V5','V6','V7','T1'];
    scenePhases: string[] = ['candidate'];
    sceneKinds: string[] = [];
    options: any;
    mode: NotificationMode = NotificationMode.all;

    constructor(_id: string) {
        this.id = _id;
    }
}

export enum NotificationMode {
    all = 0,
    single = 1
}

export enum NotificationsType {
    scenes = '八场景事件',
    alarms = 'notification.type-alarm',
    trigger = 'notification.type-trigger',
    access = 'notification.type-access'
}

export const NOTIFY_PREFIX = 'n_';
