import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

import { EndPointApi } from '../_helpers/endpointapi';
import {
    CalibrationProfile, CalibrationSession, CalibrationSessionView,
    ApplyCalibrationRequest, ConfirmationTokenResponse, CalibrationMeta
} from '../_models/calibration';

@Injectable({
    providedIn: 'root'
})
export class CalibrationService {

    private base: string = EndPointApi.getURL() + '/api/calibration';

    constructor(private http: HttpClient) {
    }

    getMeta(): Observable<CalibrationMeta> {
        return this.http.get<CalibrationMeta>(this.base + '/meta');
    }

    getProfiles(): Observable<{ profiles: CalibrationProfile[] }> {
        return this.http.get<{ profiles: CalibrationProfile[] }>(this.base + '/profiles');
    }

    getProfile(id: string): Observable<CalibrationProfile> {
        return this.http.get<CalibrationProfile>(this.base + '/profiles/' + id);
    }

    createProfile(profile: Partial<CalibrationProfile>): Observable<CalibrationProfile> {
        return this.http.post<CalibrationProfile>(this.base + '/profiles', profile);
    }

    updateProfile(id: string, profile: Partial<CalibrationProfile>): Observable<CalibrationProfile> {
        return this.http.put<CalibrationProfile>(this.base + '/profiles/' + id, profile);
    }

    deleteProfile(id: string): Observable<{ result: string }> {
        return this.http.delete<{ result: string }>(this.base + '/profiles/' + id);
    }

    validateProfile(id: string): Observable<{ profileId: string; ok: boolean; checks: any[] }> {
        return this.http.post<{ profileId: string; ok: boolean; checks: any[] }>(
            this.base + '/profiles/' + id + '/validate', {});
    }

    createSession(profileId: string): Observable<CalibrationSession> {
        return this.http.post<CalibrationSession>(this.base + '/sessions', { profileId });
    }

    getSessions(filter?: { profileId?: string; status?: string }): Observable<{ sessions: CalibrationSession[] }> {
        return this.http.get<{ sessions: CalibrationSession[] }>(this.base + '/sessions', { params: { ...filter } });
    }

    getSession(id: string): Observable<CalibrationSessionView> {
        return this.http.get<CalibrationSessionView>(this.base + '/sessions/' + id);
    }

    addPoint(sessionId: string, referenceValue: number, revision: number): Observable<any> {
        return this.http.post(this.base + '/sessions/' + sessionId + '/points',
            { referenceValue, revision }, { responseType: 'json' });
    }

    deletePoint(sessionId: string, pointId: string, revision: number): Observable<{ result: string }> {
        return this.http.delete<{ result: string }>(
            this.base + '/sessions/' + sessionId + '/points/' + pointId + '?revision=' + revision);
    }

    startSample(sessionId: string, pointId: string, revision: number): Observable<any> {
        return this.http.post(this.base + '/sessions/' + sessionId + '/points/' + pointId + '/sample',
            { revision }, { responseType: 'json' });
    }

    cancelSample(sessionId: string): Observable<any> {
        return this.http.post(this.base + '/sessions/' + sessionId + '/sample/cancel', {});
    }

    fit(sessionId: string, revision: number): Observable<any> {
        return this.http.post(this.base + '/sessions/' + sessionId + '/fit', { revision });
    }

    submit(sessionId: string, revision: number): Observable<CalibrationSession> {
        return this.http.post<CalibrationSession>(this.base + '/sessions/' + sessionId + '/submit', { revision });
    }

    approve(sessionId: string, revision: number, fitHash: string): Observable<CalibrationSession> {
        return this.http.post<CalibrationSession>(this.base + '/sessions/' + sessionId + '/approve',
            { revision, fitHash });
    }

    reject(sessionId: string, reason: string): Observable<CalibrationSession> {
        return this.http.post<CalibrationSession>(this.base + '/sessions/' + sessionId + '/reject', { reason });
    }

    confirm(sessionId: string, revision: number, fitHash: string): Observable<ConfirmationTokenResponse> {
        return this.http.post<ConfirmationTokenResponse>(this.base + '/sessions/' + sessionId + '/confirm',
            { revision, fitHash });
    }

    apply(sessionId: string, body: ApplyCalibrationRequest, idempotencyKey: string): Observable<any> {
        return this.http.post(this.base + '/sessions/' + sessionId + '/apply', body, {
            headers: new HttpHeaders({ 'Idempotency-Key': idempotencyKey })
        });
    }

    cancelSession(sessionId: string, revision: number): Observable<CalibrationSession> {
        return this.http.post<CalibrationSession>(this.base + '/sessions/' + sessionId + '/cancel', { revision });
    }

    exportSession(sessionId: string, format: 'json' | 'csv'): Observable<Blob> {
        return this.http.get(this.base + '/sessions/' + sessionId + '/export?format=' + format, {
            responseType: 'blob'
        });
    }
}
