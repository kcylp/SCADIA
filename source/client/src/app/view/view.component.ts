import { Component, OnInit, AfterViewInit, OnDestroy, ViewChild, ChangeDetectorRef, ElementRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { ActivatedRoute } from '@angular/router';

import { ProjectService } from '../_services/project.service';
import { Hmi, View, ZoomModeType } from '../_models/hmi';
import { GaugesManager } from '../gauges/gauges.component';
import { ScadiaViewComponent } from '../scadia-view/scadia-view.component';

import panzoom from 'panzoom';

@Component({
  selector: 'app-view',
  templateUrl: './view.component.html',
  styleUrls: ['./view.component.scss']
})
export class ViewComponent implements OnInit, AfterViewInit, OnDestroy {

    @ViewChild('scadiaview', {static: true}) scadiaview: ScadiaViewComponent;
	@ViewChild('container', {read: ElementRef, static: true}) container: ElementRef;

    startView: View = new View();
    hmi: Hmi = new Hmi();

    private viewName: string;

    private subscriptionLoad: Subscription;

    constructor(private projectService: ProjectService,
        private route: ActivatedRoute,
        private changeDetector: ChangeDetectorRef,
        public gaugesManager: GaugesManager) { }

    ngOnInit() {
        this.viewName = this.route.snapshot.queryParamMap.get('name');
    }

    ngAfterViewInit() {
        try {
            let hmi = this.projectService.getHmi();
            if (hmi) {
                this.loadHmi();
            }
            this.subscriptionLoad = this.projectService.onLoadHmi.subscribe(load => {
                this.loadHmi();
            }, error => {
                console.error('Error loadHMI');
            });
            this.changeDetector.detectChanges();
        }
        catch (err) {
            console.error(err);
        }
    }

    ngOnDestroy() {
        try {
            if (this.subscriptionLoad) {
                this.subscriptionLoad.unsubscribe();
            }
        } catch (e) {
        }
    }

    private loadHmi() {
        let hmi = this.projectService.getHmi();
        if (hmi) {
            this.hmi = hmi;
        }
        if (this.hmi && this.hmi.views && this.hmi.views.length > 0) {
            this.startView = this.hmi.views.find(x => x.name === this.viewName);
            // /view with no ?name= used to render NOTHING: body stayed white, no error, no
            // failed request - it just silently skipped the load below. A route that is
            // reachable from the menu must never answer with a blank page, so fall back the
            // same way /home does: the configured start screen, else the first screen.
            if (!this.startView) {
                this.startView = (this.hmi.layout && this.hmi.layout.start
                    ? this.hmi.views.find(x => x.id === this.hmi.layout.start)
                    : null) || this.hmi.views[0];
            }
            this.setBackground();
            if (this.startView && this.scadiaview) {
                this.scadiaview.loadHmi(this.startView);
            }
            if (this.hmi.layout && this.hmi.layout.zoom && ZoomModeType[this.hmi.layout.zoom] === ZoomModeType.enabled) {
                setTimeout(() => {
                    let element: HTMLElement = document.querySelector('#view');
                    if (element && panzoom) {
                        panzoom(element, {
                            bounds: true,
                            boundsPadding: 0.05,
                        });
                        this.container.nativeElement.style.overflow = 'hidden';
                    }
                }, 1000);
            }
        }
    }

    private setBackground() {
		if (this.startView && this.startView.profile) {
			document.getElementById('main-container').style.backgroundColor = this.startView.profile.bkcolor;
		}
	}
}
