module.exports = function(RED) {
    function ScadiaGetDaqNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = RED.settings.functionGlobalContext.scadia;

        this.on('input', async function(msg) {
            try {
                // Prefer config.tagId, fallback to config.tag for backward compatibility
                var tagId = config.tagId;
                if (!tagId && config.tag) {
                    // Backward compatibility: old nodes use tag.name, need to convert to tagId
                    tagId = scadia.getTagId(config.tag, null);
                }
                
                if (tagId) {
                    var fromts = config.from || msg.from || Date.now() - 3600000; // default 1 hour ago
                    var tots = config.to || msg.to || Date.now();
                    var data = await scadia.getDaq(tagId, fromts, tots);
                    msg.payload = data;
                    node.send(msg);
                } else {
                    node.error('Tag not found: ' + (config.tag || config.tagId), msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("get-daq", ScadiaGetDaqNode);
}