import { Component, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute } from '@angular/router';
@Component({
    selector:'app-analysis-workspace',
    template:'<iframe [src]="url" title="AI综合分析与模型服务配置"></iframe>',
    styles:[':host{display:block;height:100%;min-height:0}iframe{display:block;border:0;width:100%;height:100%;background:#102d48}']
})
export class AnalysisWorkspaceComponent implements OnDestroy {
    url: SafeResourceUrl;
    private sub: Subscription;
    constructor(sanitizer: DomSanitizer, route: ActivatedRoute) {
        this.sub = route.queryParamMap.subscribe(params => {
            const query = new URLSearchParams({embedded:'1'});
            for(const key of ['config','module','intent','sceneId','sceneIds','eventId','from','to','source','kind','camera','reviewStatus','verdict','acknowledged']){
                const value=params.get(key);if(value && value.length<=128){query.set(key,value);}
            }
            this.url = sanitizer.bypassSecurityTrustResourceUrl('/ai-analysis?'+query.toString());
        });
    }
    ngOnDestroy(): void { this.sub.unsubscribe(); }
}
