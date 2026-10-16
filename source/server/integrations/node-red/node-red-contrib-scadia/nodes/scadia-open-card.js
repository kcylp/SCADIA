module.exports = function(RED) {
    function ScadiaOpenCardNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = RED.settings.functionGlobalContext.scadia;

        this.on('input', async function(msg) {
            try {
                var cardName = config.cardName || msg.cardName;
                if (cardName) {
                    var result = await scadia.openCard(cardName);
                    msg.payload = result;
                    node.send(msg);
                } else {
                    node.error('Card name not specified', msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("open-card", ScadiaOpenCardNode);
}