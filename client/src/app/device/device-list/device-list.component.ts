/* eslint-disable @angular-eslint/component-class-suffix */
import { Component, OnInit, AfterViewInit, ViewChild, Input, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { MatDialog as MatDialog } from '@angular/material/dialog';
import { ChangeDetectorRef } from '@angular/core';
import { MatTable as MatTable, MatTableDataSource as MatTableDataSource } from '@angular/material/table';
import { MatPaginator as MatPaginator } from '@angular/material/paginator';
import { MatMenuTrigger as MatMenuTrigger } from '@angular/material/menu';
import { MatSort } from '@angular/material/sort';
import { SelectionModel } from '@angular/cdk/collections';
import { TranslateService } from '@ngx-translate/core';

import { TagOptionType, TagOptionsComponent } from './../tag-options/tag-options.component';
import { Tag, Device, DeviceType, TAG_PREFIX, DeviceChannel } from '../../_models/device';
import { ProjectService } from '../../_services/project.service';
import { HmiService } from '../../_services/hmi.service';
import { ConfirmDialogComponent } from '../../gui-helpers/confirm-dialog/confirm-dialog.component';
import { Utils } from '../../_helpers/utils';
import { TagPropertyService } from '../tag-property/tag-property.service';

@Component({
    selector: 'app-device-list',
    templateUrl: './device-list.component.html',
    styleUrls: ['./device-list.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class DeviceListComponent implements OnInit, AfterViewInit {

    readonly defAllColumns = ['select', 'name', 'channel', 'address', 'device', 'type', 'value', 'timestamp', 'description', 'warning', 'uns', 'logger', 'options', 'remove'];
    readonly defAllExtColumns = ['select', 'name', 'channel', 'address', 'device', 'type', 'value', 'timestamp', 'quality', 'description', 'warning', 'uns', 'logger', 'options', 'remove'];
    readonly defInternalColumns = ['select', 'name', 'device', 'type', 'value', 'timestamp', 'description', 'options', 'remove'];
    readonly defGpipColumns = ['select', 'name', 'device', 'address', 'direction', 'value', 'timestamp', 'description', 'uns', 'logger', 'options', 'remove'];
    readonly defWebcamColumns = ['select', 'name', 'device', 'address', 'value', 'timestamp', 'description', 'uns', 'logger', 'options', 'remove'];
    readonly defAllRowWidth = 1400;
    readonly defClientRowWidth = 1400;
    readonly defInternalRowWidth = 1200;

    displayedColumns = this.defAllColumns;

    dataSource = new MatTableDataSource([]);
    selection = new SelectionModel<Element>(true, []);
    devices: Device[];
    deviceType = DeviceType;
    tableWidth = this.defAllRowWidth;
    tagsMap = {};
    deviceSelected: Device = null;
    isDeviceToEdit = true;
    isWithOptions = true;

    /** Sentinel for "no channel filter" in the channel dropdown. */
    readonly channelAll = '__all__';
    /** '' means the implicit default channel; channelAll means every tag. */
    channelFilter: string = this.channelAll;
    newChannelName = '';

    @ViewChild('channelDialog', {static: false}) channelDialogTpl;

    @Input() readonly = false;
    @Output() save = new EventEmitter();
    @Output() goto = new EventEmitter();

    @ViewChild(MatTable, {static: false}) table: MatTable<any>;
    @ViewChild(MatSort, {static: false}) sort: MatSort;
    @ViewChild(MatMenuTrigger, {static: false}) trigger: MatMenuTrigger;
    @ViewChild(MatPaginator, {static: false}) paginator: MatPaginator;

    constructor(private dialog: MatDialog,
        private hmiService: HmiService,
        private translateService: TranslateService,
        private changeDetector: ChangeDetectorRef,
        private projectService: ProjectService,
        private tagPropertyService: TagPropertyService
        ) { }

    ngOnInit() {
        this.devices = this.projectService.getDevices();
        if (!this.deviceSelected && this.devices) {
            this.deviceSelected = this.devices[0];
        }
    }

    ngAfterViewInit() {
        this.dataSource.paginator = this.paginator;
        this.dataSource.sort = this.sort;
    }

    mapTags() {
        this.devices = this.projectService.getDevices();
        Object.values(this.devices).forEach(d => {
            if (d.tags) {
                Object.values(d.tags).forEach((t: Tag) => {
                    this.tagsMap[t.id] = t;
                });
            }
        });
        this.setSelectedDevice(this.deviceSelected);
    }

    private bindToTable(tags) {
        if (!tags) {
            tags = {};
        }
        // Subscribe to every tag so values keep flowing even for tags hidden by
        // the channel filter, then display only the filtered subset.
        this.hmiService.viewsTagsSubscribe(Object.keys(tags));
        this.dataSource.data = Object.values(this.filterTagsByChannel(tags));
    }

    onDeviceChange(source) {
        this.dataSource.data = [];
        this.deviceSelected = source.value;
        this.channelFilter = this.channelAll;
        this.setSelectedDevice(this.deviceSelected);
    }

    setSelectedDevice(device: Device) {
        this.devices = this.projectService.getDevices();
        this.updateDeviceValue();
        if (!device) {
            return;
        }
        this.isDeviceToEdit = !Device.isWebApiProperty(device);
        Object.values(this.devices).forEach(d => {
            if (d.name === device.name) {
                this.deviceSelected = d;
                this.bindToTable(this.deviceSelected.tags);
            }
        });
        if (this.deviceSelected.type === DeviceType.internal) {
            this.displayedColumns = this.defInternalColumns;
            this.tableWidth = this.defInternalRowWidth;
        } else if (this.deviceSelected.type === DeviceType.GPIO) {
            this.displayedColumns = this.defGpipColumns;
            this.tableWidth = this.defAllRowWidth;
        } else if (this.deviceSelected.type === DeviceType.WebCam){
            this.displayedColumns = this.defWebcamColumns;
            this.tableWidth = this.defAllRowWidth;
        } else if (this.deviceSelected.type === DeviceType.REDIS) {
            this.displayedColumns = this.defAllExtColumns;
            this.tableWidth = this.defAllRowWidth;
        } else {
            this.displayedColumns = this.defAllColumns;
            this.tableWidth = this.defAllRowWidth;
        }
        this.isWithOptions = (this.deviceSelected.type === this.deviceType.internal || this.deviceSelected.type === DeviceType.WebCam) ? false : true;
    }

    onGoBack() {
        this.goto.emit();
    }

    onRemoveRow(row) {
        const index = this.dataSource.data.indexOf(row, 0);
        if (this.dataSource.data[index]) {
            delete this.deviceSelected.tags[this.dataSource.data[index].id];
        }
        this.bindToTable(this.deviceSelected.tags);
        this.projectService.setDeviceTags(this.deviceSelected);
    }

    onRemoveAll() {
        const msg = this.translateService.instant('msg.tags-remove-all');
        let dialogRef = this.dialog.open(ConfirmDialogComponent, {
            disableClose: true,
            data: { msg: msg },
            position: { top: '60px' }
        });

        dialogRef.afterClosed().subscribe(result => {
            if (result) {
                this.clearTags();
            }
        });
    }

    private clearTags() {
        this.deviceSelected.tags = {};
        this.bindToTable(this.deviceSelected.tags);
        this.projectService.setDeviceTags(this.deviceSelected);
    }

    /** Whether the number of selected elements matches the total number of rows. */
    isAllSelected() {
        const numSelected = this.selection.selected.length;
        const numRows = this.dataSource.data.length;
        return numSelected === numRows;
    }

    /** Selects all rows if they are not all selected; otherwise clear selection. */
    masterToggle() {
        this.isAllSelected() ?
            this.selection.clear() :
            this.dataSource.data.forEach(row => this.selection.select(row));
    }

    applyFilter(filterValue: string) {
        filterValue = filterValue.trim(); // Remove whitespace
        filterValue = filterValue.toLowerCase(); // MatTableDataSource defaults to lowercase matches
        this.dataSource.filter = filterValue;
    }

    /** Edit the tag */
    onEditRow(row) {
        if (this.deviceSelected.type === DeviceType.MQTTclient || this.deviceSelected.type === DeviceType.WebSocket) {
            this.editTopics(row);
        } else {
            this.editTag(row, false);
        }
    }

    /** Edit tag options like DAQ settings */
    onEditOptions(row) {
        this.editTagOptions([row]);
    }

    onAddTag() {
        if (this.deviceSelected.type === DeviceType.OPCUA || this.deviceSelected.type === DeviceType.BACnet || this.deviceSelected.type === DeviceType.WebAPI) {
            this.addOpcTags();
        } else if (this.deviceSelected.type === DeviceType.MQTTclient || this.deviceSelected.type === DeviceType.WebSocket) {
            this.editTopics();
        } else {
            let tag = new Tag(Utils.getGUID(TAG_PREFIX));
            this.editTag(tag, true);
        }
    }

    addOpcTags() {
        if (this.deviceSelected.type === DeviceType.OPCUA) {
            this.tagPropertyService.addTagsOpcUa(this.deviceSelected, this.tagsMap).subscribe(result => {
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
        if (this.deviceSelected.type === DeviceType.BACnet) {
            this.tagPropertyService.editTagPropertyBacnet(this.deviceSelected, this.tagsMap).subscribe(result => {
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
        if (this.deviceSelected.type === DeviceType.WebAPI) {
            this.tagPropertyService.editTagPropertyWebapi(this.deviceSelected, this.tagsMap).subscribe(result => {
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
    }

    onScanRedisTag() {
        if (this.deviceSelected.type === DeviceType.REDIS) {
            this.tagPropertyService.scanTagsRedis(this.deviceSelected).subscribe(result => {
                this.bindToTable(this.deviceSelected.tags);
            });
        }
    }

    getTagLabel(tag: Tag) {
        if (this.deviceSelected.type === DeviceType.BACnet || this.deviceSelected.type === DeviceType.WebAPI) {
            return tag.label || tag.name;
        } else if (this.deviceSelected.type === DeviceType.OPCUA) {
            return tag.label;
        } else {
            return tag.name;
        }
    }

    getAddress(tag: Tag) {
        if (!tag.address) {
            return '';
        }
        if (this.deviceSelected.type === DeviceType.ModbusRTU || this.deviceSelected.type === DeviceType.ModbusTCP) {
            return parseInt(tag.address) + parseInt(tag.memaddress);
        } else if (this.deviceSelected.type === DeviceType.WebAPI) {
            if (tag.options) {
                return tag.address + ' / ' + tag.options.selval;
            }
            return tag.address;
        } else if (this.deviceSelected.type === DeviceType.MQTTclient || this.deviceSelected.type === DeviceType.WebSocket) {
            if (tag.options && tag.options.subs && tag.type === 'json') {
                return this.tagPropertyService.formatAddress(tag.address, tag.memaddress);
            }
            return tag.address;
        }
        return tag.address;
    }

    isToEdit(type, tag: Tag) {
        if (type === DeviceType.SiemensS7 || type === DeviceType.ModbusTCP || type === DeviceType.ModbusRTU ||
            type === DeviceType.internal || type === DeviceType.EthernetIP || type === DeviceType.OmronEthernetIP || type === DeviceType.SCADIAServer ||
            type === DeviceType.OPCUA || type === DeviceType.GPIO || type === DeviceType.ADSclient ||
            type === DeviceType.WebCam || type === DeviceType.MELSEC || type === DeviceType.REDIS) {
            return true;
        } else if (type === DeviceType.MQTTclient || type === DeviceType.WebSocket) {
            if (tag && tag.options && (tag.options.pubs || tag.options.subs)) {
                return true;
            }
        }
        return false;
    }

    editTag(tag: Tag, checkToAdd: boolean) {
        if (this.deviceSelected.type === DeviceType.SiemensS7) {
            this.tagPropertyService.editTagPropertyS7(this.deviceSelected, tag, checkToAdd).subscribe(result => {
                this.tagsMap[tag.id] = tag;
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
        if (this.deviceSelected.type === DeviceType.SCADIAServer) {
            this.tagPropertyService.editTagPropertyServer(this.deviceSelected, tag, checkToAdd).subscribe(result => {
                this.tagsMap[tag.id] = tag;
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
        if (this.deviceSelected.type === DeviceType.ModbusRTU || this.deviceSelected.type === DeviceType.ModbusTCP) {
            this.tagPropertyService.editTagPropertyModbus(this.deviceSelected, tag, checkToAdd).subscribe(result => {
                this.tagsMap[tag.id] = tag;
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
        if (this.deviceSelected.type === DeviceType.internal) {
            this.tagPropertyService.editTagPropertyInternal(this.deviceSelected, tag, checkToAdd).subscribe(result => {
                this.tagsMap[tag.id] = tag;
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
        if (this.deviceSelected.type === DeviceType.EthernetIP || this.deviceSelected.type === DeviceType.OmronEthernetIP) {
            this.tagPropertyService.editTagPropertyEthernetIp(this.deviceSelected, tag, checkToAdd).subscribe(result => {
                this.tagsMap[tag.id] = tag;
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
        if (this.deviceSelected.type === DeviceType.OPCUA) {
            this.tagPropertyService.editTagPropertyOpcUa(this.deviceSelected, tag, checkToAdd).subscribe(result => {
                this.tagsMap[tag.id] = tag;
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
        if (this.deviceSelected.type === DeviceType.ADSclient) {
            this.tagPropertyService.editTagPropertyADSclient(this.deviceSelected, tag, checkToAdd).subscribe(result => {
                this.tagsMap[tag.id] = tag;
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
        if (this.deviceSelected.type === DeviceType.GPIO) {
            this.tagPropertyService.editTagPropertyGpio(this.deviceSelected, tag, checkToAdd).subscribe(result => {
                this.tagsMap[tag.id] = tag;
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
        if (this.deviceSelected.type === DeviceType.WebCam) {
            this.tagPropertyService.editTagPropertyWebcam(this.deviceSelected, tag, checkToAdd).subscribe(result => {
                this.tagsMap[tag.id] = tag;
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
        if (this.deviceSelected.type === DeviceType.MELSEC) {
            this.tagPropertyService.editTagPropertyMelsec(this.deviceSelected, tag, checkToAdd).subscribe(result => {
                this.tagsMap[tag.id] = tag;
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
        if (this.deviceSelected.type === DeviceType.REDIS) {
            this.tagPropertyService.editTagPropertyRedis(this.deviceSelected, tag, checkToAdd).subscribe(result => {
                this.tagsMap[tag.id] = tag;
                this.bindToTable(this.deviceSelected.tags);
            });
            return;
        }
    }

    editTagOptions(tags: Tag[]) {
        let dialogRef = this.dialog.open(TagOptionsComponent, {
            disableClose: true,
            data: { device: this.deviceSelected, tags: tags },
            position: { top: '60px' }
        });
        dialogRef.afterClosed().subscribe((tagOption: TagOptionType) => {
            if (tagOption) {
                for (let i = 0; i < tags.length; i++) {
                    tags[i].daq = tagOption.daq;
                    tags[i].format = tagOption.format;
                    tags[i].deadband = tagOption.deadband;
                    tags[i].scale = tagOption.scale;
                    tags[i].scaleReadFunction = tagOption.scaleReadFunction;
                    tags[i].scaleReadParams = tagOption.scaleReadParams;
                    tags[i].scaleWriteFunction = tagOption.scaleWriteFunction;
                    tags[i].scaleWriteParams = tagOption.scaleWriteParams;
                    tags[i].unsPath = tagOption.unsPath;
                }
                this.projectService.setDeviceTags(this.deviceSelected);
            }
        });
    }

    updateDeviceValue() {
        let sigs = this.hmiService.getAllSignals();
        for (let id in sigs) {
            if (this.tagsMap[id]) {
                const signal = sigs[id];
                this.tagsMap[id].value = signal.value;
                this.tagsMap[id].error = signal.error;
                this.tagsMap[id].timestamp = signal.timestamp;
                this.tagsMap[id].quality = signal.quality;
            }
        }
        this.changeDetector.detectChanges();
    }

    devicesValue(): Array<Device> {
        return Object.values(this.devices);
    }

    /**
     * to add or edit MQTT topic for subscription or publish
     */
    editTopics(topic: Tag = null) {
        this.tagPropertyService.editTagPropertyMqtt(
            this.deviceSelected,
            topic,
            this.tagsMap,
            () => {
                this.bindToTable(this.deviceSelected.tags);
            }
        );
    }

    //#region Channels (device -> channel -> tag, B4)

    /** Declared channels of the selected device (never the implicit default). */
    getDeclaredChannels(): DeviceChannel[] {
        const list = this.deviceSelected && this.deviceSelected.channels;
        return Array.isArray(list) ? list.filter(c => c && c.id) : [];
    }

    /** The channel a tag belongs to; '' means the implicit default channel. */
    getTagChannelId(tag: Tag): string {
        return (tag && tag.channelId) ? String(tag.channelId) : '';
    }

    /** Display name of a tag's channel; '' when the tag is in the default channel. */
    getChannelName(tag: Tag): string {
        const id = this.getTagChannelId(tag);
        if (!id) {
            return '';
        }
        const channel = this.getDeclaredChannels().find(c => c.id === id);
        return channel ? channel.name : id;
    }

    /** Options for the channel filter dropdown ('__all__' and '' are the sentinels). */
    channelFilterOptions(): Array<{ id: string, name: string }> {
        const options = [{ id: this.channelAll, name: '__all__' }];
        this.getDeclaredChannels().forEach(c => options.push({ id: c.id, name: c.name }));
        options.push({ id: '', name: '__default__' });
        return options;
    }

    onChannelFilterChange(value: string) {
        this.channelFilter = value;
        this.bindToTable(this.deviceSelected ? this.deviceSelected.tags : {});
    }

    /** Keep only the tags of the selected channel; a missing filter keeps them all. */
    private filterTagsByChannel(tags) {
        if (!this.channelFilter || this.channelFilter === this.channelAll) {
            return tags;
        }
        const out = {};
        Object.values(tags || {}).forEach((tag: Tag) => {
            if (this.getTagChannelId(tag) === this.channelFilter) {
                out[tag.id] = tag;
            }
        });
        return out;
    }

    //#endregion

    //#region Channel management

    openChannelManager() {
        this.newChannelName = '';
        this.dialog.open(this.channelDialogTpl, { position: { top: '60px' }, minWidth: '420px' });
    }

    addChannel() {
        if (!this.deviceSelected) {
            return;
        }
        const name = (this.newChannelName || '').trim();
        if (!name) {
            return;
        }
        const channels = this.getDeclaredChannels().slice();
        if (channels.some(c => c.name === name)) {
            return;
        }
        channels.push({ id: this.uniqueChannelId(name, channels), name: name });
        this.deviceSelected.channels = channels;
        this.newChannelName = '';
        this.saveChannels();
    }

    renameChannel(channel: DeviceChannel, name: string) {
        const newName = (name || '').trim();
        if (!newName || newName === channel.name) {
            return;
        }
        channel.name = newName;
        this.saveChannels();
    }

    /** Remove a channel; its tags move back to the default channel and are never deleted. */
    removeChannel(channel: DeviceChannel) {
        if (!this.deviceSelected) {
            return;
        }
        Object.values(this.deviceSelected.tags || {}).forEach((tag: Tag) => {
            if (this.getTagChannelId(tag) === channel.id) {
                delete tag.channelId;
            }
        });
        this.deviceSelected.channels = this.getDeclaredChannels().filter(c => c.id !== channel.id);
        if (this.channelFilter === channel.id) {
            this.channelFilter = this.channelAll;
        }
        this.saveChannels();
    }

    /** Move the currently selected tags into a channel ('' = back to the default channel). */
    assignSelectedToChannel(channelId: string) {
        const selected: Tag[] = (this.selection.selected as any[]) || [];
        if (!selected.length) {
            return;
        }
        selected.forEach((tag: Tag) => {
            if (!channelId) {
                delete tag.channelId;
            } else {
                tag.channelId = channelId;
            }
        });
        this.selection.clear();
        this.saveChannels();
    }

    private uniqueChannelId(name: string, channels: DeviceChannel[]): string {
        const base = (name || '').trim().toLowerCase()
            .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '') || 'channel';
        let id = base;
        let i = 1;
        while (channels.some(c => c.id === id)) {
            id = base + '-' + (i++);
        }
        return id;
    }

    private saveChannels() {
        this.projectService.setDeviceTags(this.deviceSelected);
        this.bindToTable(this.deviceSelected.tags);
        this.changeDetector.detectChanges();
    }

    //#endregion

    onCopyTagToClipboard(tag: Tag) {
        Utils.copyToClipboard(JSON.stringify(tag));
    }
}

export interface Element extends Tag {
    position: number;
}
