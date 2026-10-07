module.exports = function(RED) {
    function ScadiaGetTagDaqSettingsNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = RED.settings.functionGlobalContext.scadia;

        this.on('input', async function(msg) {
            try {
                // Prefer config.tagId, fallback to config.tag or msg.tag for backward compatibility
                var tagId = config.tagId;
                if (!tagId) {
                    var tagName = config.tag || msg.tag;
                    if (tagName) {
                        // Backward compatibility: old nodes use tag.name, need to convert to tagId
                        tagId = scadia.getTagId(tagName, null);
                    }
                }
                
                if (tagId) {
                    var settings = await scadia.getTagDaqSettings(tagId);
                    msg.payload = settings;
                    node.send(msg);
                } else {
                    node.error('Tag not found: ' + (config.tag || msg.tag || config.tagId), msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("get-tag-daq-settings", ScadiaGetTagDaqSettingsNode);
}