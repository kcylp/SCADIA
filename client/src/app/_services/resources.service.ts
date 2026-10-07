import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

import { EndPointApi } from '../_helpers/endpointapi';
import { ResourceItem, Resources, ResourceType } from '../_models/resources';

/** One category of the built-in library, as the manifest describes it. */
export interface AssetCategory { id: string; name: string; nameEn?: string; }

/** One artwork file in the built-in library. */
export interface AssetEntry {
    id: string;
    name: string;
    category: string;
    file: string;
    width?: number;
    height?: number;
    tags?: string[];
}

export interface AssetLibrary {
    version: number;
    name: string;
    categories: AssetCategory[];
    assets: AssetEntry[];
}

/** The project-relative path an asset was copied to, and the name it got. */
export interface UsedAsset { path: string; name: string; }

@Injectable({
    providedIn: 'root'
})
export class ResourcesService {

    private endPointConfig: string = EndPointApi.getURL();

    constructor(private http: HttpClient) { }

    getResources(type: ResourceType): Observable<Resources> {
        let header = new HttpHeaders({ 'Content-Type': 'application/json' });
        let params = { type: type };
        return this.http.get<Resources>(this.endPointConfig + '/api/resources/' + type, { headers: header, params: params });
    }

    removeWidget(widget: ResourceItem): Observable<any> {
        let header = new HttpHeaders({ 'Content-Type': 'application/json' });
        let params = { path: widget.path };
        return this.http.post<any>(this.endPointConfig + '/api/resources/removeWidget', params, { headers: header });
    }

    generateImage(imageProperty: any) {
        let header = new HttpHeaders({ 'Content-Type': 'application/json' });
        const requestOptions: Object = {
            /* other options here */
            responseType: 'text',
            headers: header,
            params: { param: JSON.stringify(imageProperty) },
            // observe: 'response'
        };
        return this.http.get<any>(this.endPointConfig + '/api/resources/generateImage', requestOptions);
    }

    /**
     * The built-in asset library that ships with the software.
     *
     * Read straight from the static mount, so it needs no token and works before a project
     * is even open: the library belongs to the software, not to the site.
     */
    getAssetLibrary(): Observable<AssetLibrary> {
        return this.http.get<AssetLibrary>(this.endPointConfig + '/_assets/manifest.json');
    }

    /**
     * Put one library asset into THIS project.
     *
     * Answers with the project-relative web path of the COPY, because that is what the view
     * must reference: a screen may not depend on a library that can be updated underneath it.
     */
    useAsset(file: string): Observable<UsedAsset> {
        const header = new HttpHeaders({ 'Content-Type': 'application/json' });
        return this.http.post<UsedAsset>(this.endPointConfig + '/api/resources/useAsset',
            { file: file }, { headers: header });
    }

    isVideo(path: string): boolean {
        const videoExtensions = ['.mp4', '.webm', '.ogg'];
        return videoExtensions.some(ext => path.toLowerCase().endsWith(ext));
    }
}
