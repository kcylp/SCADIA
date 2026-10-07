/**
 * THE BUILT-IN NAVIGATION.
 *
 * Until now the left menu was entirely project data: LayoutSettings.navigation.items, edited in
 * the editor and stored in the project. A project that never configured it therefore had NO
 * menu at all - the software shipped with twenty-five routes and showed three of them, behind a
 * floating button. This table is the floor: what the software can do, grouped the way industrial
 * software groups it, available to every project without anybody configuring anything.
 *
 * It is deliberately ONE declarative table rather than markup, so "does the navigation match the
 * backend" is answered by reading twenty-five lines instead of auditing twenty templates.
 *
 * Two kinds of entry, and the difference matters:
 *
 *   page(...)  navigates to an application route  (view: LinkType.address, link: '<route>')
 *   screen(...) switches to a PROJECT SCREEN, by view id, and only exists if the project has it
 *
 * Group order follows how a plant is actually worked: look at it, then the data, then the assets
 * behind it, then what automates it, then the system itself, and last the engineering tools.
 */

import { LinkType, NaviItem } from './hmi';
import { Utils } from '../_helpers/utils';

function item(id: string, text: string, icon: string): NaviItem {
    const navi = new NaviItem();
    navi.id = id;
    navi.text = text;
    navi.icon = icon;
    return navi;
}

/** An application route: /device, /alarms, /reports ... */
function page(id: string, text: string, icon: string, route: string): NaviItem {
    const navi = item(id, text, icon);
    navi.view = LinkType.address;
    navi.link = route;
    return navi;
}

/** A group: a header that expands, never a destination itself. */
function group(id: string, text: string, icon: string, children: NaviItem[]): NaviItem {
    const navi = item(id, text, icon);
    navi.children = children;
    return navi;
}

/**
 * Every route this application serves, grouped. Keep in step with app.routing.ts: a route that
 * exists here and not there navigates nowhere, and the reverse is a page nobody can reach.
 */
export const DEFAULT_NAVIGATION: NaviItem[] = [
    group('g-overview', 'nav.group-overview', 'dashboard', [
        page('n-home', 'nav.overview', 'home', 'home'),
        // /home, not /view: /view requires ?name=<screen> and would open blank without it.
        // /home resolves the configured start screen (falling back to the first one), which
        // is what "画面" is meant to do from a menu.
        page('n-view', 'nav.view', 'image', 'home')
    ]),
    group('g-monitor', 'nav.group-monitor', 'visibility', [
        page('n-video', 'nav.video', 'video_settings', 'video'),
        page('n-alarms', 'nav.alarms', 'notifications_active', 'alarms')
    ]),
    group('g-data', 'nav.group-data', 'analytics', [
        page('n-messages', 'nav.alarm-history', 'history', 'messages'),
        page('n-reports', 'nav.reports', 'assessment', 'reports'),
        page('n-recipes', 'nav.recipes', 'menu_book', 'recipes'),
        // The two KPI boards read like the rest of this group: figures an operator looks at.
        page('n-mes', 'nav.mes', 'precision_manufacturing', 'mes'),
        page('n-ems', 'nav.ems', 'electric_bolt', 'ems')
    ]),
    group('g-asset', 'nav.group-asset', 'memory', [
        page('n-device', 'nav.device', 'developer_board', 'device'),
        page('n-cameras', 'nav.cameras', 'videocam', 'cameras'),
        page('n-locations', 'nav.locations', 'map', 'mapsLocations'),
        page('n-calibrations', 'nav.calibrations', 'tune', 'calibrations')
    ]),
    group('g-automation', 'nav.group-automation', 'bolt', [
        page('n-scripts', 'nav.scripts', 'code', 'scripts'),
        page('n-flows', 'nav.flows', 'account_tree', 'flows'),
        page('n-notifications', 'nav.notifications', 'campaign', 'notifications')
    ]),
    group('g-system', 'nav.group-system', 'settings', [
        page('n-users', 'nav.users', 'people', 'users'),
        page('n-roles', 'nav.roles', 'admin_panel_settings', 'userRoles'),
        page('n-language', 'nav.language', 'translate', 'language'),
        page('n-plugins', 'nav.plugins', 'extension', 'plugins'),
        page('n-apikeys', 'nav.apikeys', 'vpn_key', 'apikeys'),
        page('n-logs', 'nav.logs', 'article', 'logs'),
        page('n-armarkers', 'nav.armarkers', 'view_in_ar', 'arMarkers')
    ]),
    group('g-engineering', 'nav.group-engineering', 'design_services', [
        page('n-editor', 'nav.editor', 'edit', 'editor'),
        page('n-lab', 'nav.lab', 'science', 'lab')
    ])
];

/** A fresh copy, so no two components ever share (and mutate) the same item objects. */
export function defaultNavigation(): NaviItem[] {
    return Utils.clone(DEFAULT_NAVIGATION);
}
