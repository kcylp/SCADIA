module.exports = function(RED) {
    function ScadiaSetTagDaqSettingsNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = this.context().global.get('scadia');

        this.on('input', async function(msg) {
            try {
                var tagName = config.tag || msg.tag;
                if (tagName) {
                    var tagId = scadia.getTagId(tagName, null);
                    if (tagId) {
                        var settings = {
                            enabled: config.enabled,
                            interval: config.interval,
                            deadband: config.deadband
                        };

                        // Override with message properties if provided
                        if (msg.enabled !== undefined) settings.enabled = msg.enabled;
                        if (msg.interval !== undefined) settings.interval = msg.interval;
                        if (msg.deadband !== undefined) settings.deadband = msg.deadband;

                        var result = await scadia.setTagDaqSettings(tagId, settings);
                        msg.payload = result;
                        node.send(msg);
                    } else {
                        node.error('Tag not found: ' + tagName, msg);
                    }
                } else {
                    node.error('Tag name not specified', msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("set-tag-daq-settings", ScadiaSetTagDaqSettingsNode);
}