import { Component, OnInit, Inject, OnDestroy, ViewChild } from '@angular/core';
import { MatDialogRef as MatDialogRef, MAT_DIALOG_DATA as MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatExpansionPanel } from '@angular/material/expansion';
import { Subscription, delay } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';

import { EndPointSettings, HmiService } from '../../_services/hmi.service';
import { AppService } from '../../_services/app.service';
import { ProjectService } from '../../_services/project.service';
import { DeviceType, DeviceSecurity, MessageSecurityMode, SecurityPolicy, ModbusOptionType, ModbusReuseModeType, RedisReadModeType, RedisOptions } from './../../_models/device';

@Component({
	selector: 'app-device-property',
	templateUrl: './device-property.component.html',
	styleUrls: ['./device-property.component.scss']
})
export class DevicePropertyComponent implements OnInit, OnDestroy {

    /** The subscribe frame template shown as a placeholder. A JSON code frame is not UI copy: it stays out of the i18n layer (batch 90-AG). */
    readonly subscribeFramePlaceholder = '{"type":"subscribe","tags":["{{tags}}"]}';
	// @Input() name: any;
	@ViewChild('panelProperty', { static: false }) panelProperty: MatExpansionPanel;
	@ViewChild('panelCertificate', { static: false }) panelCertificate: MatExpansionPanel;

	tableRadio: any;
	databaseTables = [];

	securityRadio: any;
	mode: any;
	deviceType: any = {};
	showPassword: boolean;

	pollingPlcType = [{ text: 'device.property-poll-ms-50', value: 50 },
	{ text: 'device.property-poll-ms-100', value: 100 },
	{ text: 'device.property-poll-ms-200', value: 200 },
	{ text: 'device.property-poll-ms-350', value: 350 },
	{ text: 'device.property-poll-ms-500', value: 500 },
	{ text: 'device.property-poll-ms-700', value: 700 },
	{ text: 'device.property-poll-sec-1', value: 1000 },
	{ text: 'device.property-poll-sec-1-5', value: 1500 },
	{ text: 'device.property-poll-sec-2', value: 2000 },
	{ text: 'device.property-poll-sec-3', value: 3000 },
	{ text: 'device.property-poll-sec-4', value: 4000 },
	{ text: 'device.property-poll-sec-5', value: 5000 },
	{ text: 'device.property-poll-sec-10', value: 10000 },
	{ text: 'device.property-poll-sec-30', value: 30000 },
	{ text: 'device.property-poll-min-1', value: 60000 }];

	pollingWebApiType = [{ text: 'device.property-poll-sec-1', value: 1000 },
	{ text: 'device.property-poll-sec-2', value: 2000 },
	{ text: 'device.property-poll-sec-3', value: 3000 },
	{ text: 'device.property-poll-sec-5', value: 5000 },
	{ text: 'device.property-poll-sec-10', value: 10000 },
	{ text: 'device.property-poll-sec-30', value: 30000 },
	{ text: 'device.property-poll-min-1', value: 60000 },
	{ text: 'device.property-poll-min-2', value: 60000 * 2 },
	{ text: 'device.property-poll-min-5', value: 60000 * 5 },
	{ text: 'device.property-poll-min-10', value: 60000 * 10 },
	{ text: 'device.property-poll-min-30', value: 60000 * 30 },
	{ text: 'device.property-poll-min-60', value: 60000 * 60 }];

	pollingWebCamType = this.pollingWebApiType.concat([{ text: 'device.property-poll-disabled', value: -1 }]);

	pollingType = this.pollingPlcType;


	isSCADIAServer = false;
	isToRemove = false;
	propertyError = '';
	propertyExpanded: boolean;
	propertyLoading: boolean;
	securityMode: any = [];
	security = new DeviceSecurity();
	baudrateType = [110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 115200, 128000, 256000, 921600];
	databitsType = [7, 8];
	stopbitsType = [1, 1.5, 2];
	parityType = ['None', 'Odd', 'Even'];
	methodType = ['GET'];//, 'POST'];
	parserType = ['JSON'];//, 'CSV'];
	hostInterfaces = [];
	modbusRtuOptionType = [ModbusOptionType.SerialPort, ModbusOptionType.RTUBufferedPort, ModbusOptionType.AsciiPort];
	modbusTcpOptionType = [ModbusOptionType.TcpPort, ModbusOptionType.UdpPort, ModbusOptionType.TcpRTUBufferedPort, ModbusOptionType.TelnetPort];
	modbusReuseModeType = ModbusReuseModeType;
	redisReadModeType = RedisReadModeType;
	redisReadModeSimple = RedisReadModeType.simple;
	redisReadModeHash = RedisReadModeType.hash;
	// redisReadModeCustom = RedisReadModeType.custom;
	redisOptions = new RedisOptions();
	writeArgsTooltip = '';
	result = '';
	private subscriptionDeviceProperty: Subscription;
	private subscriptionHostInterfaces: Subscription;
	private subscriptionDeviceWebApiRequest: Subscription;

	private projectService: ProjectService;

	constructor(
		private hmiService: HmiService,
		private translateService: TranslateService,
		private appService: AppService,
		public dialogRef: MatDialogRef<DevicePropertyComponent>,
		@Inject(MAT_DIALOG_DATA) public data: any) {
		this.projectService = data.projectService;
	}

	ngOnInit() {
		this.isToRemove = this.data.remove;
		this.isSCADIAServer = (this.data.device.type && this.data.device.type === DeviceType.SCADIAServer) ? true : false;
		for (let key in DeviceType) {
			if (!this.isSCADIAServer && key !== DeviceType.SCADIAServer) {
				for (let idx = 0; idx < this.data.availableType.length; idx++) {
					if (key.startsWith(this.data.availableType[idx])) {
						this.deviceType[key] = DeviceType[key];
					}
				}
			}
		}
		// set default is only one type
		if (this.data.availableType.length === 1) {
			this.data.device.type = this.data.availableType[0];
		}

		this.subscriptionDeviceProperty = this.hmiService.onDeviceProperty.subscribe(res => {
			if (res.type === DeviceType.OPCUA) {
				this.securityMode = [];
				if (res.result) {
					let secPol = SecurityPolicy;
					for (let idx = 0; idx < res.result.length; idx++) {
						let sec = res.result[idx];
						let mode = this.securityModeToString(sec.securityMode);
						if (sec.securityPolicy.indexOf(secPol.None) !== -1) {
							this.securityMode.push({ value: sec, text: SecurityPolicy.None.toString() + ' - ' + mode });
						} else if (sec.securityPolicy.indexOf(secPol.Basic128Rsa15) !== -1) {
							this.securityMode.push({ value: sec, text: SecurityPolicy.Basic128Rsa15.toString() + ' - ' + mode });
						} else if (sec.securityPolicy.indexOf(secPol.Basic128) !== -1) {
							this.securityMode.push({ value: sec, text: SecurityPolicy.Basic128.toString() + ' - ' + mode });
						} else if (sec.securityPolicy.indexOf(secPol.Basic192Rsa15) !== -1) {
							this.securityMode.push({ value: sec, text: SecurityPolicy.Basic192Rsa15.toString() + ' - ' + mode });
						} else if (sec.securityPolicy.indexOf(secPol.Basic192) !== -1) {
							this.securityMode.push({ value: sec, text: SecurityPolicy.Basic192.toString() + ' - ' + mode });
						} else if (sec.securityPolicy.indexOf(secPol.Basic256Rsa15) !== -1) {
							this.securityMode.push({ value: sec, text: SecurityPolicy.Basic256Rsa15.toString() + ' - ' + mode });
						} else if (sec.securityPolicy.indexOf(secPol.Basic256Sha256) !== -1) {
							this.securityMode.push({ value: sec, text: SecurityPolicy.Basic256Sha256.toString() + ' - ' + mode });
						} else if (sec.securityPolicy.indexOf(secPol.Basic256) !== -1) {
							this.securityMode.push({ value: sec, text: SecurityPolicy.Basic256.toString() + ' - ' + mode });
						} else if (sec.securityPolicy.indexOf(secPol.Aes128_Sha256_RsaOaep) !== -1) {
							this.securityMode.push({ value: sec, text: SecurityPolicy.Aes128_Sha256_RsaOaep.toString() + ' - ' + mode });
						} else if (sec.securityPolicy.indexOf(secPol.Aes256_Sha256_RsaPss) !== -1) {
							this.securityMode.push({ value: sec, text: SecurityPolicy.Aes256_Sha256_RsaPss.toString() + ' - ' + mode });
						}
						if (this.isSecurityMode(sec)) {
							this.securityRadio = sec;
						}
					}
					this.propertyError = '';
				} else if (res.error) {
					this.propertyError = res.error;
				}
			} else if (res.type === DeviceType.BACnet) {
			} else if (res.type === DeviceType.ODBC) {
				if (res?.error) {
					this.propertyError = res.error;
				} else {
					this.databaseTables = res.result;
					for (let idx = 0; idx < res.result?.length; idx++) {
						if (this.isSecurityMode(res.result[idx])) {
							this.tableRadio = res.result[idx];
						}
					}
					this.propertyError = '';
				}
			}
			this.propertyLoading = false;
		});
		// check security
		if (this.data.device.id && (this.data.device.type === DeviceType.OPCUA || this.data.device.type === DeviceType.MQTTclient
			|| this.data.device.type === DeviceType.ODBC || this.data.device.type === DeviceType.WebSocket)) {
			this.projectService.getDeviceSecurity(this.data.device.id).pipe(
				delay(500)
			).subscribe(result => {
				if (result) {
					this.setSecurity(result.value);
				}
			}, err => {
				console.error('get Device Security err: ' + err);
			});
		}

		if (this.data.device.property) {
			if (!this.data.device.property.baudrate) {
				this.data.device.property.baudrate = 9600;
			}
			if (!this.data.device.property.databits) {
				this.data.device.property.databits = 8;
			}
			if (!this.data.device.property.stopbits) {
				this.data.device.property.stopbits = 1;
			}
			if (!this.data.device.property.parity) {
				this.data.device.property.parity = 'None';
			}
			if (!this.data.device.property.forceFC16) {
				this.data.device.property.forceFC16 = false;
			}
			if (!this.data.device.property.timeout) {
				this.data.device.property.timeout = (this.data.device.type === DeviceType.MQTTclient ||
					this.data.device.type === DeviceType.WebSocket) ? 10000 : 2000;
			}
		}
		if (this.data.device.type === DeviceType.REDIS) {
			const opts = this.data.device?.property?.options;
			this.redisOptions = (typeof opts === 'string')
				? new RedisOptions()
				: (opts || new RedisOptions());
		}
		this.subscriptionHostInterfaces = this.hmiService.onHostInterfaces.subscribe(res => {
			if (res.result) {
				this.hostInterfaces = res;
			}
		});
		this.subscriptionDeviceWebApiRequest = this.hmiService.onDeviceWebApiRequest.subscribe(res => {
			if (res.result) {
				this.result = JSON.stringify(res.result);
			}
			this.propertyLoading = false;
		});
		this.writeArgsTooltip = this.translateService.instant('device.property-redis-write-args-tooltip');
		this.onDeviceTypeChanged();
	}

	ngOnDestroy() {
		try {
			if (this.subscriptionDeviceProperty) {
				this.subscriptionDeviceProperty.unsubscribe();
			}
			if (this.subscriptionHostInterfaces) {
				this.subscriptionHostInterfaces.unsubscribe();
			}
			if (this.subscriptionDeviceWebApiRequest) {
				this.subscriptionDeviceWebApiRequest.unsubscribe();
			}
		} catch (err) {
			console.error(err);
		}
	}

	onNoClick(): void {
		this.dialogRef.close();
	}

	onOkClick(): void {
		this.data.security = this.getSecurity();
		if (this.data.device.type === DeviceType.REDIS) {
			this.data.device.property.options = this.redisOptions;
		}
	}

	onCheckOpcUaServer() {
		this.propertyLoading = true;
		this.propertyError = '';
		this.hmiService.askDeviceProperty(this.data.device.property.address, this.data.device.type);
	}

	onCheckWebApi() {
		this.propertyLoading = true;
		this.result = '';
		this.hmiService.askWebApiProperty(this.data.device.property);
	}

	onCheckOdbc() {
		this.propertyLoading = true;
		this.result = '';
		this.hmiService.askDeviceProperty(<EndPointSettings>{
			address: this.data.device.property.address,
			uid: this.security.username,
			pwd: this.security.password,
			id: this.data.device.id
		}, this.data.device.type);
	}

	// onCheckBACnetDevice() {
	// 	this.propertyLoading = true;
	// 	this.hmiService.askDeviceProperty(this.data.device.property.address, this.data.device.type);
	// }

	onPropertyExpand(status) {
		this.propertyExpanded = status;
	}

	onAddressChanged() {
		this.propertyLoading = false;
	}

	onDeviceTypeChanged() {
		if (this.data.device.type === DeviceType.WebAPI) {
			this.pollingType = this.pollingWebApiType;
		} else if (this.data.device.type === DeviceType.WebCam) {
			this.pollingType = this.pollingWebCamType;
		} else {
			this.pollingType = this.pollingPlcType;
		}
	}

	isValid(device): boolean {
		if (!device.name || !device.type) {
			return false;
		}
		return (this.data.exist.find((n) => n === device.name)) ? false : true;
	}

	isSecurityMode(sec) {
		if (JSON.stringify(this.mode) === JSON.stringify(sec)) {
			return true;
		} else {
			return false;
		}
	}

	getSecurity(): DeviceSecurityGeneral {
		if (this.propertyExpanded && this.data.device.type === DeviceType.OPCUA) {
			if (this.securityRadio || this.security.username || this.security.password) {
				let result = <DeviceSecurityGeneral>{
					mode: this.securityRadio,
					uid: this.security.username,
					pwd: this.security.password
				};
				return result;
			}
		} else if (this.propertyExpanded && (this.data.device.type === DeviceType.MQTTclient ||
			this.data.device.type === DeviceType.WebSocket)) {
			if (this.security.clientId || this.security.username || this.security.password || this.security.certificateFileName ||
				this.security.privateKeyFileName || this.security.caCertificateFileName) {
				let result = <DeviceSecurityGeneral>{
					clientId: this.security.clientId,
					uid: this.security.username,
					pwd: this.security.password,
					cert: this.security.certificateFileName,
					pkey: this.security.privateKeyFileName,
					caCert: this.security.caCertificateFileName
				};
				return result;
			}
		} else if (this.data.device.type === DeviceType.ODBC) {
			if (this.tableRadio || this.security.username || this.security.password) {
				let result = <DeviceSecurityGeneral>{
					mode: this.tableRadio,
					uid: this.security.username,
					pwd: this.security.password
				};
				return result;
			}
		}
		return null;
	}

	setSecurity(security: string) {
		if (security && security !== 'null') {
			let value = <DeviceSecurityGeneral>JSON.parse(security);
			this.mode = value.mode;
			this.security.username = value.uid;
			this.security.password = value.pwd;
			this.security.clientId = value.clientId;
			this.security.grant_type = value.gt;
			if (value.uid || value.pwd || value.clientId) {
				this.panelProperty?.open();
			}
			this.security.certificateFileName = value.cert;
			this.security.privateKeyFileName = value.pkey;
			this.security.caCertificateFileName = value.caCert;
			if (value.cert || value.pkey || value.caCert) {
				this.panelCertificate?.open();
			}
		}
	}

	keyDownStopPropagation(event) {
		event.stopPropagation();
	}

	isWithPolling() {
		if (this.data.device?.type === DeviceType.internal) {
			return false;
		}
		if (this.appService.isClientApp || this.appService.isDemoApp) {
			return false;
		}
		return true;
	}

	canEnable() {
		if (this.isSCADIAServer || this.data.device?.type === this.deviceType.internal) {
			return false;
		}
		return true;
	}

	onAddWriteKey() {
		this.redisOptions.customCommand.write.args.push({
			name: '',
			value: '',
		});
	}

	onRemoveWriteKey(idx: number) {
		this.redisOptions.customCommand.write.args.splice(idx, 1);
	}

	private securityModeToString(mode): string {
		// This is a SYNCHRONOUS function that returns `result`, and the subscribes above it could not
		// have fired before the return: it returned '' EVERY TIME, and the caller renders that. The
		// three branches are user-visible text on a property panel, read long after the language pack
		// loaded, so instant() is the correct call.
		let secMode = MessageSecurityMode;
		if (mode === secMode.NONE) {
			return this.translateService.instant('device.security-none');
		} else if (mode === secMode.SIGN) {
			return this.translateService.instant('device.security-sign');
		} else if (mode === secMode.SIGNANDENCRYPT) {
			return this.translateService.instant('device.security-signandencrypt');
		}
		return '';
	}
}

interface DeviceSecurityGeneral {
	mode: string;
	gt: string;
	uid: string;
	pwd: string;
	clientId: string;
	cert: string;
	pkey: string;
	caCert: string;
}
