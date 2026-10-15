'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const { ModelConfig } = require('../../api/analysis/model-config');
const analysis = require('../../api/analysis');
const auth = require('../../api/jwt-helper');

describe('Analysis model configuration boundary', () => {
    let dir, config, server, base;
    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-model-'));
        config = new ModelConfig(dir);
        analysis.init({ settings:{workDir:dir}, users:{getUserCache:id=>({admin:{groups:-1},viewer:{groups:2},demoted:{groups:2}})[id]} }, (_req,_res,next)=>next(), ()=>-1);
        server = analysis.app().listen(0,'127.0.0.1');
        await new Promise(r=>server.once('listening',r)); base='http://127.0.0.1:'+server.address().port;
    });
    afterEach(async () => { await new Promise(r=>server.close(r)); fs.rmSync(dir,{recursive:true,force:true}); });
    const token=(id,type)=>jwt.sign({id,type,groups:-1},auth.secretCode,{expiresIn:60});
    const req=(base,method,key,body)=>fetch(base+'/api/analysis/config',{method,headers:{'Content-Type':'application/json',...(key?{'x-access-token':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
    it('requires a signed current administrator even with open viewing and rejects refresh tokens', async () => {
        for (const [key,status] of [[null,401],[token('viewer'),403],[token('demoted'),403],[token('missing'),403],[token('admin','refresh'),403]]) {
            assert.equal((await req(base,'GET',key)).status,status);
            assert.equal((await req(base,'POST',key,{model:'deepseek-chat'})).status,status);
        }
        assert(!fs.existsSync(config.file));
    });
    it('saves and reads status without returning a secret and persists across reopening', async () => {
        const r=await req(base,'POST',token('admin'),{baseUrl:'https://api.deepseek.com',model:'deepseek-chat',apiKey:'test-only-secret'});
        assert.equal(r.status,200);
        const result=await r.json();assert.equal(result.updatedBy,'admin');assert(result.keyConfigured);
        assert(!JSON.stringify(result).includes('test-only-secret'));assert(!Object.hasOwn(result,'apiKey'));
        const stored=new ModelConfig(dir);assert.equal(stored.read().apiKey,'test-only-secret');
        config.save({model:'deepseek-reasoner',apiKey:''},'admin');assert.equal(config.read().apiKey,'test-only-secret');
        config.save({clearKey:true},'admin');assert.equal(config.read().apiKey,'');
    });
    it('rejects credentials in URLs, unsupported hosts, CRLF keys and unknown fields without replacing configuration', () => {
        config.save({apiKey:'test-only-secret'},'admin');const before=fs.readFileSync(config.file,'utf8');
        for(const value of [{baseUrl:'http://127.0.0.1'},{baseUrl:'https://api.deepseek.com.evil.test'},{baseUrl:'https://user:pass@api.deepseek.com'},{baseUrl:'https://api.deepseek.com/?key=x'},{apiKey:'bad\r\nheader'},{model:'a\n'},{extra:1},{clearKey:true,apiKey:'new'}]) {
            assert.throws(()=>config.save(value,'admin'));
            assert.equal(fs.readFileSync(config.file,'utf8'),before);
        }
        assert(!fs.readdirSync(dir).some(f=>f.endsWith('.tmp')));
    });
});
