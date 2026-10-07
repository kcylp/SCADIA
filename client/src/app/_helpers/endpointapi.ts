import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

@Injectable()
export class EndPointApi {
    private static url: string = null;

    public static getBasePath(): string {
        // this uses the base defined in main.js to obtain the base path.
        // if not found, it simply ignores it
        // <base href="/scadia/"> -> "/scadia" ; "/" -> ""
        const href = document.querySelector('base')?.getAttribute('href') || '/';
        try {
            return new URL(href, location.origin).pathname.replace(/\/+$/, '');
        }
        catch (err) {
            return '';
        }
    }

    public static getURL() {
        if (!this.url) {
            if (environment.apiEndpoint) {
                this.url = environment.apiEndpoint;
            } else if (environment.serverEnabled) {
                // Served BY the server - the normal deployment. The API is this very origin,
                // whatever host and port the operator reached it on.
                //
                // This used to rewrite the port to environment.apiPort unconditionally, on the
                // theory that the page must have come from a development server. It did not
                // check, so a server started with '--port 1900' served a UI that then called
                // 1900's host on port 1881: the page loaded and every request failed. Reaching
                // the same install by IP or by DNS name broke the same way.
                this.url = location.origin + this.getBasePath();
            } else {
                // Served by a development server (ng serve, demo): the API lives on its own
                // port, on whichever host this page was loaded from.
                const protocol = location.protocol.replace(':', '');
                const port = environment.apiPort ? ':' + environment.apiPort : '';
                this.url = protocol + '://' + location.hostname + port + this.getBasePath();
            }
        }
        return this.url;
    }

    /**
     * @deprecated as of version 1.3.3 this is not used anywhere
     */
    public static getRemoteURL(destIp: string) {
        const protocol = location.origin.split(':')[0];
        const path = destIp + ':' + environment.apiPort;
        return protocol + '://' + path + '/api';

    }

    public static resolveUrl = (input?: string) => {
        // todo check what happens when behind a proxy
        if (!input) {
            return '';
        }
        try { return new URL(input, window.location.origin).toString(); }
        catch { return input.startsWith('/') ? input : '/' + input; }
    };
}
