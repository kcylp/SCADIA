module.exports = function(RED) {
    function ScadiaGetTagIdNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = RED.settings.functionGlobalContext.scadia;

        this.on('input', async function(msg) {
            try {
                var tagName = config.tagName || msg.tagName;
                if (tagName) {
                    var tagId = scadia.getTagId(tagName, null);
                    msg.payload = tagId;
                    node.send(msg);
                } else {
                    node.error('Tag name not specified', msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("get-tag-id", ScadiaGetTagIdNode);
}