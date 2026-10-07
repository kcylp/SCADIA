import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subject, takeUntil } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { ProjectService } from '../../_services/project.service';
import { PluginService } from '../../_services/plugin.service';
import { Plugin, PluginGroupType, PluginType } from '../../_models/plugin';
import { Utils } from '../../_helpers/utils';

interface PluginViewModel extends Plugin {
    working?: boolean;
}

@Component({
    selector: 'app-plugins-list',
    templateUrl: './plugins-list.component.html',
    styleUrls: ['./plugins-list.component.scss']
})
export class PluginsListComponent implements OnInit, OnDestroy {

    plugins: PluginViewModel[] = [];
    installing: string;
    removing: string;
    installed: string;
    removed: string;
    error: string;

    private destroy$ = new Subject<void>();

    constructor(
        private translateService: TranslateService,
        private projectService: ProjectService,
        private pluginService: PluginService
    ) { }

    ngOnInit() {
        this.translateService.get('dlg.plugins-status-installing').subscribe((txt: string) => this.installing = txt);
        this.translateService.get('dlg.plugins-status-removing').subscribe((txt: string) => this.removing = txt);
        this.translateService.get('dlg.plugins-status-installed').subscribe((txt: string) => this.installed = txt);
        this.translateService.get('dlg.plugins-status-removed').subscribe((txt: string) => this.removed = txt);
        this.translateService.get('dlg.plugins-status-error').subscribe((txt: string) => this.error = txt);

        this.loadPlugins();

        this.projectService.onLoadHmi.pipe(
            takeUntil(this.destroy$)
        ).subscribe(_ => this.loadPlugins());

        this.pluginService.onPluginsChanged.pipe(
            takeUntil(this.destroy$)
        ).subscribe(_ => this.loadPlugins());
    }

    ngOnDestroy() {
        this.destroy$.next();
        this.destroy$.complete();
    }

    install(plugin: PluginViewModel) {
        plugin.status = this.installing;
        plugin.working = true;

        const payload: Plugin = Utils.clone(plugin);
        payload.pkg = true;

        this.pluginService.installPlugin(payload).subscribe(() => {
            plugin.status = this.installed;
            plugin.current = plugin.version;
            plugin.working = false;
        }, error => {
            plugin.status = this.error + error;
            plugin.working = false;
        });
    }

    remove(plugin: PluginViewModel) {
        plugin.status = this.removing;
        plugin.working = true;

        this.pluginService.removePlugin(plugin).subscribe(() => {
            plugin.status = this.removed;
            plugin.current = '';
            plugin.working = false;
        }, error => {
            plugin.status = this.error + error;
            plugin.working = false;
        });
    }

    isInstalled(plugin: PluginViewModel) {
        return !!plugin.current?.length;
    }

    isInstallDisabled(plugin: PluginViewModel) {
        return plugin.working || this.isInstalled(plugin) || !plugin.dinamic;
    }

    isRemoveDisabled(plugin: PluginViewModel) {
        return plugin.working || !plugin.canRemove || !this.isInstalled(plugin);
    }

    /**
     * The icon for one plugin row.
     *
     * Fixed on 2026-10-02: this used to switch on `plugin.type` while two of its cases were
     * written with PluginGroupType members. `type` holds a driver name ('OPCUA', 'Modbus'), and
     * the GROUP is what arrives as 'chart-report'/'service' - so the chart and service icons were
     * unreachable, and every plugin that was not a driver fell through to the generic extension
     * icon. The group cases were also compared against the wrong VALUES (see _models/plugin.ts).
     *
     * The order is deliberate: the driver cases come first because a plugin can be both a driver
     * and a named driver of a group (chart.js is group 'chart-report' but carries type 'Chart'),
     * and the more specific answer is the driver icon.
     */
    getPluginIcon(plugin: PluginViewModel) {
        const group = plugin.group as PluginGroupType;
        switch (plugin.type) {
        case PluginType.OPCUA:
        case PluginType.BACnet:
        case PluginType.Modbus:
        case PluginType.Raspberry:
        case PluginType.SiemensS7:
        case PluginType.EthernetIP:
        case PluginType.OmronEthernetIP:
        case PluginType.MELSEC:
        case PluginType.REDIS:
            return 'settings_input_component';
        default:
            break;
        }
        switch (group) {
        case PluginGroupType.Chart:
            return 'insert_chart';
        case PluginGroupType.Service:
            return 'miscellaneous_services';
        case PluginGroupType.ConnectionDatabase:
            return 'storage';
        case PluginGroupType.ConnectionDevice:
            return 'settings_input_component';
        default:
            return 'extension';
        }
    }

    private loadPlugins() {
        this.pluginService.getPlugins().subscribe(plugins => {
            this.plugins = [...plugins].sort((a, b) => this.sortPlugins(a, b));
        }, error => {
            console.error('Error getPlugins', error);
        });
    }

    private sortPlugins(a: PluginViewModel, b: PluginViewModel) {
        if (!!a.dinamic !== !!b.dinamic) {
            return a.dinamic ? -1 : 1;
        }
        return `${a.group}-${a.name}`.localeCompare(`${b.group}-${b.name}`);
    }
}
