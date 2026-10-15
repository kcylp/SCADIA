/**
 * How a fixed-size drawing canvas is mapped onto the browser viewport.
 *
 * A SCADA canvas has a design size (View.profile.width/height, e.g. 1920x1080 for a
 * control-room video wall). The operator may open it on a laptop, a 24/27/32 inch monitor,
 * a 4K LED wall, or across several extended screens, so the viewport almost never matches
 * the design size and the canvas has to be fitted at runtime.
 *
 * Deliberately a leaf module with no imports: it is shared by Utils (the scaling engine)
 * and by the HMI models, and importing it from either side must not create a module cycle.
 * _models/hmi re-exports it, so existing imports keep working.
 */
export enum PropertyScaleModeType {
    /** Draw at 1:1 design pixels, overflow scrolls. */
    none = 'none',
    /** Uniform scale, whole canvas visible and centered. Nothing is ever cut off. */
    contain = 'contain',
    /** Non-uniform scale to fill exactly. Keeps the legacy behaviour, distorts the aspect ratio. */
    stretch = 'stretch',
    /** Uniform scale to fill, overflow is cropped. Removes the letterbox on a video wall. */
    cover = 'cover',
    /** Uniform scale to the available width, the rest scrolls vertically. */
    width = 'width',
    /**
     * Full-bleed, and nothing cropped: TWO layers instead of one.
     *
     * A screen whose artwork is a full-canvas backdrop image can be shown on a display of any
     * shape without either black bars (contain) or a cropped control (cover). The backdrop is
     * painted behind, scaled to COVER, and the canvas on top keeps its CONTAIN fit, so every
     * control stays whole while the picture reaches the edges.
     *
     * This is what a control room wall and a 16:10 laptop have in common: the viewport never
     * matches the design aspect, and the operator should not be able to tell.
     */
    fill = 'fill'
}

/** Scale modes that can be chosen for a whole view, in menu order. */
export const VIEW_SCALE_MODES: PropertyScaleModeType[] = [
    PropertyScaleModeType.fill,
    PropertyScaleModeType.contain,
    PropertyScaleModeType.cover,
    PropertyScaleModeType.stretch,
    PropertyScaleModeType.width,
    PropertyScaleModeType.none
];
