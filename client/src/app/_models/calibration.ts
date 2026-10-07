/**
 * Calibration domain models (开诚智枢scada 标定模块)
 */

export interface CalibrationSampling {
    sampleCount: number;
    intervalMs: number;
    maxAgeMs: number;
    timeoutMs: number;
    filter: 'none' | 'mad';
    madThreshold: number;
    minAcceptedRatio: number;
    maxStdDev?: number;
    maxCvPercent?: number;
    minValue?: number;
    maxValue?: number;
}

export interface CalibrationQuality {
    minPoints: number;
    minR2?: number;
    maxRmse?: number;
    maxAbsError?: number;
    minRawSpan?: number;
    forbidExtrapolation: boolean;
}

export interface TagWriteSpec {
    mode: 'tags';
    gainTagId: string;
    offsetTagId: string;
    writeOrder: ('gain' | 'offset')[];
    verifyDelayMs: number;
    verifyTolerance: number;
    rollbackOnFailure: boolean;
}

export interface RawBlockWriteSpec {
    mode: 'raw-block';
    deviceId: string;
    addressBase: 0 | 1;
    startAddress: number;
    functionCode: 16;
    payload: 'coefficients' | 'points-interleaved';
    numericType: string;
    wordOrder: string;
    verifyDelayMs: number;
    verifyMode: 'bytes' | 'numeric';
    verifyTolerance: number;
    rollbackOnFailure: boolean;
}

export interface CalibrationProfile {
    id?: string;
    name: string;
    description?: string;
    sourceTagId: string;
    sourceUnit?: string;
    model: 'linear';
    sampling: CalibrationSampling;
    quality: CalibrationQuality;
    write: TagWriteSpec | RawBlockWriteSpec;
    version?: number;
    createdAt?: string;
    updatedAt?: string;
}

export type CalibrationStatus =
    | 'draft' | 'sampling' | 'ready' | 'fitted' | 'awaiting-approval' | 'approved'
    | 'writing' | 'verifying' | 'applied' | 'failed' | 'uncertain' | 'canceled';

export interface CalibrationSample {
    timestamp: number;
    value: number | null;
    sourceTimestamp?: number;
    accepted: boolean;
    rejectReason?: string;
}

export interface CalibrationPointStats {
    mean?: number;
    median?: number;
    stdDev?: number;
    min?: number;
    max?: number;
    cvPercent?: number;
    stable?: boolean;
    stableViolations?: string[];
}

export interface CalibrationPoint {
    id: string;
    sessionId: string;
    sequence: number;
    referenceValue: number;
    stats?: CalibrationPointStats | null;
    samples: CalibrationSample[];
    createdAt?: string;
    updatedAt?: string;
}

export interface LinearFitResult {
    model: 'linear';
    direction: 'raw-to-reference';
    gain: number;
    offset: number;
    r2: number;
    rmse: number;
    maxAbsError: number;
    rawMin: number;
    rawMax: number;
    residuals: Array<{
        pointId: string;
        raw: number;
        reference: number;
        predicted: number;
        residual: number;
    }>;
    qualityPassed: boolean;
    violations: string[];
    calculatedAt: string;
}

export interface CalibrationSession {
    id: string;
    profileId: string;
    profileVersion: number;
    status: CalibrationStatus;
    operatorId: string;
    approverId?: string;
    fit?: LinearFitResult | null;
    fitHash?: string | null;
    revision: number;
    approvalExpiresAt?: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
}

export interface CalibrationSessionView {
    session: CalibrationSession;
    points: CalibrationPoint[];
    audit: CalibrationAuditRecord[];
    profile?: CalibrationProfile;
}

export interface CalibrationAuditRecord {
    id: string;
    sessionId: string;
    idempotencyKey: string;
    operatorId: string;
    approverId?: string;
    request: any;
    beforeHex?: string;
    intendedHex?: string;
    readbackHex?: string;
    rollbackHex?: string;
    status: string;
    errorCode?: string;
    errorMessage?: string;
    previousHash?: string;
    recordHash: string;
    createdAt: string;
    completedAt?: string;
}

export interface ApplyCalibrationRequest {
    revision: number;
    fitHash: string;
    confirmationToken: string;
}

export interface ConfirmationTokenResponse {
    sessionId: string;
    revision: number;
    fitHash: string;
    confirmationToken: string;
    expiresAt: string;
}

export interface CalibrationMeta {
    module: string;
    secureEnabled: boolean;
    writeEnabled: boolean;
    rawWriteEnabled: boolean;
}
