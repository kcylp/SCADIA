'use strict';
const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {Calibration,validate}=require('../../runtime/cameras/scene-calibration');
const valid=()=>({gate:{enabled:true,points:[[.2,.2],[.8,.2],[.8,.9],[.2,.9]],line:[[.2,.5],[.8,.5]],insidePoint:[.5,.8]},confirmed:true});
describe('Door calibration validation',()=>{
 it('requires explicit confirmation and rejects degenerate geometry',()=>{
  assert(validate(valid()).verified);
  assert.throws(()=>validate({...valid(),confirmed:false}),/确认/);
  const b=valid();b.gate.line=[[.5,.5],[.5,.5]];assert.throws(()=>validate(b),/退化/);
  const c=valid();c.gate.points[0]=[NaN,0];assert.throws(()=>validate(c),/有效点/);
  assert.throws(()=>validate(null),/缺少/);
 });
 it('rejects crossing, repeated and backtracking polygon edges',()=>{
  for(const points of [
   [[.1,.1],[.9,.9],[.1,.8],[.8,.1]],
   [[.2,.2],[.8,.2],[.8,.9],[.2,.2],[.2,.9]],
   [[.1,.1],[.8,.1],[.5,.1],[.8,.9],[.1,.9]]
  ]){const b=valid();b.gate.points=points;assert.throws(()=>validate(b),/自交|重复|退化/);}
 });
 it('requires the threshold and interior point to be in the doorway',()=>{
  const b=valid();b.gate.line=[[.1,.5],[.9,.5]];assert.throws(()=>validate(b),/区域内/);
  const c=valid();c.gate.insidePoint=[.9,.8];assert.throws(()=>validate(c),/区域内/);
  const d=valid();d.gate.line=[[.2,.2],[.8,.2]];assert.throws(()=>validate(d),/两侧/);
  const e=valid();e.gate.insidePoint=[.2,.8];assert.throws(()=>validate(e),/区域内/);
 });
 it('rejects a line bridging the notch of a concave ROI',()=>{
  const b=valid();
  b.gate.points=[[.1,.1],[.9,.1],[.9,.9],[.6,.9],[.6,.3],[.4,.3],[.4,.9],[.1,.9]];
  b.gate.line=[[.2,.6],[.8,.6]];b.gate.insidePoint=[.2,.8];
  assert.throws(()=>validate(b),/区域内/);
  b.gate.line=[[.1,.2],[.9,.2]];
  assert(validate(b).verified);
 });
 it('accepts either polygon winding and line order without changing the inside side',()=>{
  const b=valid();b.gate.points.reverse();b.gate.line.reverse();
  assert.deepEqual(validate(b).insidePoint,[.5,.8]);
 });
 it('disables without retaining an unverified polygon',()=>assert.deepEqual(validate({gate:{enabled:false}}),{enabled:false,verified:false}));
});
describe('Door calibration persistence',()=>{
 let dir;
 beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'scadia-gate-'));fs.writeFileSync(path.join(dir,'ai-tracker.json'),JSON.stringify({cameraId:'test-camera',unrelated:{preserve:true}}));});
 afterEach(()=>fs.rmSync(dir,{recursive:true,force:true}));
 it('reads back saved versions after restart and rejects stale writes without changing configuration',()=>{
  const service=new Calibration(dir), saved=service.save({...valid(),version:'none'},'test-admin');
  assert.notEqual(saved.version,'none');assert.equal(saved.gate.calibratedBy,'test-admin');
  assert.deepEqual(new Calibration(dir).read(),saved);
  const file=path.join(dir,'ai-tracker.json'),before=fs.readFileSync(file,'utf8');
  assert.throws(()=>service.save({...valid(),version:'none'},'test-admin'),/更新/);
  assert.equal(fs.readFileSync(file,'utf8'),before);
  const invalid=valid();invalid.gate.insidePoint=[1,1];
  assert.throws(()=>service.save({...invalid,version:saved.version},'test-admin'),/区域内/);
  assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.deepEqual(JSON.parse(before).unrelated,{preserve:true});
  assert(!fs.readdirSync(dir).some(f=>f.endsWith('.tmp')));
  const disabled=service.save({gate:{enabled:false},version:saved.version},'test-admin');
  assert.notEqual(disabled.version,saved.version);assert.equal(disabled.gate.enabled,false);
  assert.equal(disabled.gate.verified,false);assert(!disabled.gate.points);
 });
});
