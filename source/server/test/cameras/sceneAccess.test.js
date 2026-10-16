'use strict';
const assert=require('assert');
const cameras=require('../../api/cameras');
const fs=require('fs'),os=require('os'),path=require('path');
describe('Global scene HTTP permissions',function(){
    this.timeout(12000);
    let dir,server,role,settings;
    beforeEach(async()=>{
        dir=fs.mkdtempSync(path.join(os.tmpdir(),'scadia-scene-acl-'));
        fs.mkdirSync(path.join(dir,'images'));fs.mkdirSync(path.join(dir,'scene-evidence'));
        fs.writeFileSync(path.join(dir,'scene-evidence','scene-'+ 'a'.repeat(32)+'.jpg'),'historical-image');
        settings={secureEnabled:true,workDir:dir,imagesFileDir:path.join(dir,'images')};role='ordinary';
        const runtime={project:{},settings,logger:{warn(){},error(){}},cameraScenes:{
            status:()=>({visible:{camera:'test'}}),list:async()=>({rows:[],count:0}),
            getEvent:async id=>{
                if(!/^[a-f0-9]{32}$/.test(id))throw Object.assign(new Error('Invalid event id'),{code:'AI_BAD_PAYLOAD'});
                if(id!=='a'.repeat(32))throw Object.assign(new Error('Event not found'),{code:'CAM_NOT_FOUND'});
                return {eventId:id,shot:'scene-'+id+'.jpg',at:1};
            }}};
        cameras.init(runtime,(req,res,next)=>{req.isAuthenticated=role!=='guest';req.userId=role;req.userGroups=role==='admin'?255:1;next();},()=>role==='admin'?255:1);
        server=cameras.app().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    });
    afterEach(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
    const urls=['/api/ai/scenes','/api/ai/scenes/frame/invalid','/api/ai/scene-events','/api/ai/scene-events/'+ 'a'.repeat(32)+'/evidence'];
    const call=url=>fetch('http://127.0.0.1:'+server.address().port+url);
    it('denies guests and ordinary users at all global scene read boundaries',async()=>{
        for(const who of ['guest','ordinary']){role=who;for(const url of urls)assert.equal((await call(url)).status,who==='guest'?401:403,url);}
    });
    it('permits admin reads and serves only the requested historical image',async()=>{
        role='admin';assert.equal((await call(urls[0])).status,200);assert.equal((await call(urls[2])).status,200);
        const shot=await call(urls[3]);assert.equal(shot.status,200);assert.equal(await shot.text(),'historical-image');
        assert.equal((await call('/api/ai/scene-events/'+ 'b'.repeat(32)+'/evidence')).status,404);
        assert.equal((await call('/api/ai/scene-events/invalid/evidence')).status,400);
        assert.equal((await call(urls[1])).status,404);
    });
    it('retains explicit open-mode viewing while changes still require authentication',async()=>{
        settings.secureEnabled=false;role='guest';assert.equal((await call(urls[0])).status,200);assert.equal((await call(urls[2])).status,200);
        const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/ai/scene-events/'+ 'a'.repeat(32)+'/ack',{method:'POST'});
        assert.equal(response.status,401);
    });
});
