import { Component, AfterViewInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { MatDialogRef as MatDialogRef } from '@angular/material/dialog';
import { Subscription } from 'rxjs';

import { ResourceGroup, Resources, ResourceType } from '../../_models/resources';
import { AssetEntry, ResourcesService } from '../../_services/resources.service';
import { EndPointApi } from '../../_helpers/endpointapi';

/** One library thumbnail: the manifest file name, its human name, and where to fetch it. */
interface LibraryThumb { file: string; name: string; url: string; }

@Component({
    selector: 'app-lib-images',
    templateUrl: './lib-images.component.html',
    styleUrls: ['./lib-images.component.css']
})
export class LibImagesComponent implements AfterViewInit, OnDestroy {
    private endPointConfig: string = EndPointApi.getURL();
    resImages?: ResourceGroup[];
    subscription: Subscription;

    /**
     * The built-in library, grouped the way its manifest groups it.
     *
     * It sits in front of the project's own images on purpose: a new screen usually starts
     * from artwork the product already owns, and until now there was no way to find it.
     */
    libraryGroups?: { name: string; items: LibraryThumb[] }[];
    libraryBusy = false;
    /** An i18n key, not a sentence: the template translates it. */
    libraryError: string = null;

    constructor(
        private dialogRef: MatDialogRef<LibImagesComponent>,
        private resourcesService: ResourcesService,
        private changeDetector: ChangeDetectorRef) { }

    ngAfterViewInit() {
        this.loadResources();
        this.loadLibrary();
    }

    ngOnDestroy() {
        try {
            this.subscription.unsubscribe();
        } catch (err) {
            console.error(err);
        }
    }

    loadResources() {
        this.subscription = this.resourcesService.getResources(ResourceType.images).subscribe((result: Resources) => {
            const groups = result?.groups || [];
            groups.forEach(group => {
                group.items.forEach(item => {
                    item.path = `${this.endPointConfig}/${item.path}`;
                });
            });
            this.resImages = groups;
        }, err => {
            console.error('get Resources images error: ' + err);
        });
    }

    /** Read the manifest and present it by category, with thumbnails. */
    loadLibrary() {
        this.resourcesService.getAssetLibrary().subscribe(library => {
            const categoryName = new Map<string, string>();
            (library?.categories || []).forEach(category => categoryName.set(category.id, category.name));

            const groups = new Map<string, LibraryThumb[]>();
            (library?.assets || []).forEach((asset: AssetEntry) => {
                const group = categoryName.get(asset.category) || asset.category;
                if (!groups.has(group)) {
                    groups.set(group, []);
                }
                groups.get(group).push({
                    file: asset.file,
                    name: asset.name,
                    url: this.endPointConfig + '/_assets/' + encodeURIComponent(asset.file)
                });
            });
            this.libraryGroups = Array.from(groups.entries()).map(entry => ({ name: entry[0], items: entry[1] }));
            this.changeDetector.detectChanges();
        }, err => {
            this.libraryError = 'resources.lib-error';
            console.error('get asset library error: ' + err);
        });
    }

    /**
     * Use a library asset: copy it into this project first, then hand back the COPY's path.
     * The dialog closes with a project path, exactly as it does for the project's own images,
     * so nothing downstream has to know the picture came from a library.
     */
    onSelectLibrary(item: LibraryThumb) {
        if (this.libraryBusy) {
            return;
        }
        this.libraryBusy = true;
        this.libraryError = null;
        this.resourcesService.useAsset(item.file).subscribe(result => {
            this.libraryBusy = false;
            this.onSelect(this.endPointConfig + '/' + result.path);
        }, err => {
            this.libraryBusy = false;
            this.libraryError = 'resources.lib-use-error';
            console.error('use asset error: ' + err);
        });
    }

    onSelect(imgPath: string) {
        this.dialogRef.close(imgPath);
    }

    onNoClick(): void {
        this.dialogRef.close();
    }

    isVideo(path: string): boolean {
        return this.resourcesService.isVideo(path);
    }
}
