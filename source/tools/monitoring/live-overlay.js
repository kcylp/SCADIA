var m = window.__monitor;
if (m) {
    // Retire old body-level overlays: video belongs inside its SVG viewport and below dialogs.
    if (window.__liveOverlay && window.__liveOverlay.timer) { clearInterval(window.__liveOverlay.timer); window.__liveOverlay.timer = null; }
    document.querySelectorAll('img[id^="lo_"]').forEach(function (e) { e.remove(); });
    m.streamClient = m.streamClient || 'ui_' + Math.random().toString(36).slice(2);
    m.panes().forEach(function (p) {
        var id = 'live_' + p.id, fo = document.getElementById(id);
        if (!fo || fo.parentNode !== p.parentNode) {
            if (fo) { fo.remove(); }
            fo = m.node('foreignObject', { id: id, 'pointer-events': 'none' });
            var img = document.createElement('img'); img.id = 'live_img_' + p.id;
            img.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;background:#050b14';
            img.alt = m.thermal(p) ? '红外热成像' : '可见光实时画面';
            img.onerror = function () { m.errors['stream_' + p.id] = '视频断流'; img.dataset.retry = String(Date.now() + 10000); };
            img.onload = function () { delete m.errors['stream_' + p.id]; };
            fo.appendChild(img); p.parentNode.insertBefore(fo, p.nextSibling);
        }
        ['x', 'y', 'width', 'height'].forEach(function (a) { fo.setAttribute(a, p.getAttribute(a)); });
        var im = fo.firstChild, source = m.source(p), now = Date.now();
        var stats = ((m.data.video || {}).sources || {})[source];
        var cid = m.streamClient + '_' + source;
        var unavailable = m.errors.video || !stats || !stats.updatedAt || now - stats.updatedAt > 8000;
        if (stats && stats.cameraId !== p.getAttribute('data-camera-id')) { unavailable = true; }
        var disconnected = stats && im.dataset.opened && m.at.video > Number(im.dataset.opened) + 1000 && stats.clientIds.indexOf(cid) < 0;
        if (unavailable || disconnected) {
            m.errors['stream_' + p.id] = unavailable ? '视频源未更新 / 关联异常' : '视频连接已断开';
            if (!im.dataset.retry) { im.dataset.retry = String(now + 5000); }
        } else if (stats && !im.dataset.retry) { delete m.errors['stream_' + p.id]; }
        im.style.visibility = unavailable ? 'hidden' : 'visible';
        if (!im.src || (im.dataset.retry && Date.now() >= Number(im.dataset.retry))) {
            delete im.dataset.retry;
            m.streamUrls = m.streamUrls || {};
            m.streamUpdated = m.streamUpdated || {};
            if (!m.streamUrls[source] || m.errors['stream_' + p.id] && now - (m.streamUpdated[source] || 0) >= 5000) {
                m.streamUpdated[source] = now;
                m.streamUrls[source] = location.protocol + '//' + location.hostname + ':1886/mjpeg/' + source + '?c=' + cid + '&t=' + Date.now();
            }
            // Equal src values let the browser share one physical stream for duplicate panes.
            im.src = m.streamUrls[source]; im.dataset.opened = String(now);
        }
        // Keep the SVG image as a geometry anchor; do not open another MJPEG connection.
        p.setAttribute('href', 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=');
        p.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
    });
}
