// UI rendering and management

class UIManager {
    constructor(container) {
        this.container = container;
        this.elements = {};
    }

    renderDayPhase() {
        // TODO: Render day phase hub - shops, gifting, gardening
    }

    renderNightPhase() {
        // TODO: Render night phase combat - no UI overlay
    }

    updateCurrency(trust, debt) {
        // TODO: Update trust/debt display (if visible at all)
    }

    showRumorFragment(text) {
        // TODO: Display overheard rumor conversation
    }

    showVendor(vendorId) {
        // TODO: Render shop interface
    }

    hideAll() {
        // TODO: Clear all UI elements
    }
}

class Rumor {
    constructor(id, content, originNeighbor) {
        this.id = id;
        this.content = content;
        this.originNeighbor = originNeighbor;
        this.spread = [];
        this.corruptions = [];
        this.ageInTicks = 0;
    }

    propagate(neighbors) {
        // TODO: Spread rumor to adjacent neighbors
    }
}
