module.exports = function(RED) {
    function ScadiaSetTagNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = this.context().global.get('scadia');

        this.on('input', async function(msg) {
            try {
                var tagId = scadia.getTagId(config.tag, null);
                if (tagId) {
                    await scadia.setTag(tagId, msg.payload);
                    node.send(msg);
                } else {
                    node.error('Tag not found: ' + config.tag, msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("set-tag", ScadiaSetTagNode);
}