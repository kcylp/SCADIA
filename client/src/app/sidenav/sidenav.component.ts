import { Component, Input, Output, EventEmitter, ChangeDetectorRef, AfterContentChecked } from '@angular/core';
import { MatSidenav } from '@angular/material/sidenav';
import { Location } from '@angular/common';

import { LayoutSettings, NaviItem, NavigationSettings, LinkType, NaviItemType } from '../_models/hmi';
import { defaultNavigation } from '../_models/default-navigation';
import { Router } from '@angular/router';
import { ProjectService } from '../_services/project.service';
import { LanguageService } from '../_services/language.service';
import { Utils } from '../_helpers/utils';

@Component({
    selector: 'app-sidenav',
    templateUrl: './sidenav.component.html',
    styleUrls: ['./sidenav.component.scss']
})
export class SidenavComponent implements AfterContentChecked {

    @Input() sidenav: MatSidenav;
    @Output() goToPage: EventEmitter<string> = new EventEmitter();
    @Output() goToLink: EventEmitter<string> = new EventEmitter();

    viewAsLink = LinkType.address;
    viewAsAlarms = LinkType.alarms;

    logo = null;
    layout: LayoutSettings = null;
    showSidenav = false;
    layoutNavigation = new NavigationSettings();
    expandedItems: Set<string> = new Set();
    private expandableNavItems = [Utils.getEnumKey(NaviItemType, NaviItemType.text), Utils.getEnumKey(NaviItemType, NaviItemType.inline)];

    constructor(private location: Location,
                private router: Router,
                private projectService: ProjectService,
                private languageService: LanguageService,
                private changeDetector: ChangeDetectorRef) {
    }

    ngAfterContentChecked(): void {
        this.showSidenav = (this.layout) ? true : false;
        this.changeDetector.detectChanges();
    }

    onGoTo(item: NaviItem) {
        if (this.location.path().startsWith('/home/')) {
            const view = this.projectService.getViewFromId(item.view);
            if (view) {
                this.router.navigate(['/home', view.name]);
            }
        }
        if (item.link && item.view === this.viewAsLink) {
            this.goToLink.emit(item.link);
        } else if (item.view) {
            this.goToPage.emit(item.view);
        }
    }

    toggleSubMenu(item: NaviItem) {
        if (item.id && item.children?.length) {
            if (this.expandedItems.has(item.id)) {
                this.expandedItems.delete(item.id);
            } else {
                this.expandedItems.add(item.id);
            }
            this.changeDetector.detectChanges();
        }
    }

    isExpanded(item: NaviItem): boolean {
        return item.id ? this.expandedItems.has(item.id) : false;
    }

    isExpandable(item: NaviItem): boolean {
        // Any item that HAS children expands. This used to also require the menu's visual
        // style to be text or inline, which made a group a dead end in the other two styles
        // - including 'block', the default - so a grouped menu could not be opened at all.
        // The style decides how an item LOOKS; whether it opens is decided by its children.
        return item.children?.length > 0;
    }

    public setLayout(layout: LayoutSettings) {
        // A project without a layout row is legal, and used to mean no menu at all: the
        // software has twenty-five routes and the left bar offered none of them. Fall back to
        // the built-in table so every project starts from everything-is-reachable, and let the
        // editor narrow it from there. hidenavigation stays the deliberate opt-out.
        this.layout = layout ? Utils.clone(layout) : new LayoutSettings();
        if (!this.layout.navigation) {
            this.layout.navigation = new NavigationSettings();
        }
        if (!this.layout.navigation.items?.length && !this.layout.hidenavigation) {
            this.layout.navigation.items = defaultNavigation();
        }
        {
            this.layoutNavigation = this.layout.navigation;
            this.logo = this.layout.navigation.logo;
            this.layout.navigation.items.forEach(item => {
                item.text = this.languageService.getTranslation(item.text) ?? item.text;
                if (!item.id) {
                    item.id = Utils.getShortGUID();
                }
                item.children?.forEach(child => {
                    child.text = this.languageService.getTranslation(child.text) ?? child.text;
                    if (!child.id) {
                        child.id = Utils.getShortGUID();
                    }
                });
            });
        }
    }
}
