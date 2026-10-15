import unittest
from scadia_entry_gate import EntryGate
from scadia_scenes import SceneEngine


def track(tid, x, y, tracked=True):
    return {'id': tid, 'xyxy': [x-2, y-10, x+2, y], 'conf': .9, 'tracked': tracked}


class GateTests(unittest.TestCase):
    def gate(self):
        return EntryGate({'enabled': True, 'points': [[.2,.2],[.8,.2],[.8,.9],[.2,.9]],
                          'line': [[.2,.5],[.8,.5]], 'insidePoint': [.5,.8], 'stableFrames': 2})

    def run_path(self, gate, xs, tid=1, start=0):
        out=[]
        for i,(x,y) in enumerate(xs):
            _,events=gate.update([track(tid,x,y)],100,100,start+i*.1)
            out.extend(events)
        return out

    def test_entry_once_and_no_indoor_bootstrap(self):
        g=self.gate()
        self.assertEqual(len(self.run_path(g,[(50,40),(50,40),(50,60),(50,60),(50,65)])),1)
        self.assertEqual(self.run_path(g,[(50,60)]*4,2,2),[])
        self.assertEqual(self.run_path(g,[(10,40),(10,40),(10,60),(10,60)],3,3),[])

    def test_exit_jitter_and_pause_not_entry(self):
        for path in [[(50,65),(50,65),(50,40),(50,40)],[(50,49),(50,51)]*4,[(50,40)]*8]:
            self.assertEqual(self.run_path(self.gate(),path),[])

    def test_missing_frames_break_stability_and_do_not_rearm_inside(self):
        g=self.gate()
        self.run_path(g,[(50,40),(50,40),(50,60)])
        g.update([],100,100,.3)
        self.assertEqual(self.run_path(g,[(50,60)]*4,start=.4),[])
        self.assertEqual(len(self.run_path(g,[(50,40)]*2+[(50,60)]*2,start=1)),1)

    def test_roi_departure_resets_both_sides_of_stability(self):
        g=self.gate()
        self.run_path(g,[(50,40),(50,40),(50,60)])
        self.run_path(g,[(10,60)],start=.3)
        self.assertEqual(self.run_path(g,[(50,60)]*4,start=.4),[])
        self.assertEqual(len(self.run_path(g,[(50,40)]*2+[(50,60)]*2,start=1)),1)

    def test_frame_local_and_duplicate_ids_cannot_establish_a_crossing(self):
        g=self.gate()
        for at,y in enumerate([40,60]):
            t=track(1,50,y)
            self.assertEqual(g.update([t,t],100,100,at*.1)[1],[])
        for at,y in enumerate([40,40,60,60]):
            self.assertEqual(self.gate().update([track(1,50,y,False)],100,100,at*.1)[1],[])

    def test_long_gap_and_line_endpoint_bypass_do_not_count(self):
        g=self.gate();self.run_path(g,[(50,40)]*2)
        self.assertEqual(self.run_path(g,[(50,60)]*4,start=3),[])
        g=EntryGate({'enabled':True,'points':[[.1,.1],[.9,.1],[.9,.9],[.1,.9]],
                     'line':[[.4,.5],[.6,.5]],'insidePoint':[.5,.8]})
        self.assertEqual(self.run_path(g,[(25,40)]*2+[(25,60)]*2),[])

    def test_adjacent_people_each_count_and_an_inside_id_switch_does_not(self):
        g=self.gate();events=[]
        for i,y in enumerate([40,40,60,60]):
            events.extend(g.update([track(1,50,y),track(2,54,y)],100,100,i*.1)[1])
        self.assertEqual([e['id'] for e in events],[1,2])
        self.assertEqual(self.run_path(g,[(50,60)]*4,tid=3,start=.4),[])

    def test_endpoint_bypass_does_not_consume_a_later_real_crossing(self):
        g=EntryGate({'enabled':True,'points':[[.1,.1],[.9,.1],[.9,.9],[.1,.9]],
                     'line':[[.4,.5],[.6,.5]],'insidePoint':[.5,.8]})
        self.assertEqual(self.run_path(g,[(25,40)]*2+[(25,60)]*2),[])
        self.assertEqual(len(self.run_path(g,[(50,40)]*2+[(50,60)]*2,start=.5)),1)

    def test_invalid_worker_gate_is_rejected(self):
        cfg={'enabled':True,'points':[[.2,.2],[.8,.2],[.8,.9],[.2,.9]],
             'line':[[.2,.5],[.8,.5]],'insidePoint':[.9,.8]}
        with self.assertRaises(ValueError):EntryGate(cfg)
        cfg['insidePoint']=[.5,.8];cfg['line']=[[.2,.2],[.8,.2]]
        with self.assertRaises(ValueError):EntryGate(cfg)
        cfg['line']=[[.2,.5],[.8,.5]];cfg['margin']=float('nan')
        with self.assertRaises(ValueError):EntryGate(cfg)

    def test_same_id_can_exit_and_enter_again_after_stable_outside(self):
        g=self.gate()
        self.assertEqual(len(self.run_path(g,[(50,40)]*2+[(50,60)]*2)),1)
        # One outside sample and margin jitter cannot rearm a completed entry.
        self.assertEqual(self.run_path(g,[(50,40),(50,50)]+[(50,60)]*3,start=.4),[])
        self.assertEqual(self.run_path(g,[(50,40)]*2,start=1),[])
        self.assertEqual(len(self.run_path(g,[(50,60)]*2,start=1.2)),1)
        self.assertEqual(self.run_path(g,[(50,60)]*4,start=1.4),[])

    def test_after_reconnect_inside_not_recounted(self):
        g=self.gate();self.run_path(g,[(50,40),(50,40),(50,60),(50,60)])
        self.assertEqual(self.run_path(self.gate(),[(50,60)]*5,1,10),[])


class SceneTests(unittest.TestCase):
    def test_missing_models_never_report_healthy(self):
        states,events=SceneEngine({}).update([],100,100,1)
        self.assertEqual(len(states),7)
        self.assertTrue(all(s['status'] in ['limited','calibration_required','normal'] for s in states))
        self.assertEqual(events,[])

    def test_four_people_immediate_crowding_and_recovery(self):
        e=SceneEngine({})
        tracks=[track(i,20*i,50) for i in range(1,5)]
        self.assertEqual(e.update(tracks[:3],100,100,0)[1],[])
        self.assertEqual(e.update(tracks,100,100,1)[1][0][0],'crowding')
        self.assertEqual(e.update(tracks,100,100,2)[1],[])
        e.update(tracks[:3],100,100,3)
        self.assertEqual(e.update(tracks,100,100,4)[1][0][0],'crowding')
        e.update([],100,100,5)
        self.assertEqual(e.update(tracks[:3]+[tracks[0]],100,100,6)[1],[])

    def test_stationary_30_seconds_movement_and_lost_track_reset(self):
        e=SceneEngine({})
        events=[]
        for at in range(31):
            events.extend(e.update([track(1,50,50)],100,100,at)[1])
        self.assertEqual([x[0] for x in events],['loitering'])
        self.assertEqual(e.update([track(1,50,50)],100,100,31)[1],[])
        self.assertEqual(e.update([track(1,60,50)],100,100,32)[1],[])
        self.assertEqual(e.stationary['1']['since'],32)
        e.update([],100,100,33)
        e.update([track(1,60,50)],100,100,34)
        self.assertEqual(e.stationary['1']['since'],34)
        e.update([track(1,60,50)],100,100,40)
        self.assertEqual(e.stationary['1']['since'],40)

    def test_new_office_candidates_are_not_inverted_or_dependent_on_label(self):
        e=SceneEngine({'_helmetReady':True,'_poseReady':True})
        t=track(1,50,50);t.update(lowPosture=True,handToMouth=True,helmet=True)
        self.assertEqual({x[0] for x in e.update([t],100,100,0)[1]}, {'fall','smoking','helmet'})
        self.assertEqual(e.update([t],100,100,1)[1],[])
        e.update([],100,100,2)
        t=track(2,50,50);t['label']='人员·未戴安全帽'
        self.assertEqual(e.update([t],100,100,3)[1],[])

    def test_right_to_left_entry_once(self):
        gate=EntryGate({'enabled':True,'points':[[0,0],[1,0],[1,1],[0,1]],
                        'line':[[.5,.1],[.5,.9]],'insidePoint':[.2,.5],'stableFrames':2})
        self.assertEqual(len(GateTests().run_path(gate,[(70,60),(65,60),(35,60),(30,60),(25,60)])),1)
        self.assertEqual(GateTests().run_path(gate,[(30,60),(35,60),(65,60),(70,60)],2,2),[])

    def test_thermal_never_inherits_visible_rules(self):
        states,events=SceneEngine({'streamKind':'thermal'}).update([],100,100,1)
        self.assertEqual([s['sceneId'] for s in states],['T1']);self.assertEqual(events,[])

class ReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import importlib.util
        from pathlib import Path
        spec = importlib.util.spec_from_file_location('scene_review', Path(__file__).with_name('scadia-scene-review.py'))
        cls.review = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.review)

    def result(self, scene, observation='present', count=None, context=None, images=1):
        import json
        value = {'observation': observation, 'peopleCount': count, 'facts': '可见事实', 'limitations': ''}
        return self.review.parse_review(json.dumps(value), scene, json.dumps(context or {}), images)

    def test_observation_maps_verdict_without_a_second_model_decision(self):
        for observation, verdict in [('present','支持'),('absent','不支持'),('unclear','证据不足')]:
            self.assertEqual(self.result('V4', observation)['verdict'], verdict)
        with self.assertRaises(ValueError):
            self.result('V4', '支持')

    def test_crowding_requires_a_consistent_visible_count(self):
        self.assertEqual(self.result('V5','absent',0)['verdict'],'不支持')
        self.assertEqual(self.result('V5','present',4)['verdict'],'支持')
        self.assertEqual(self.result('V5','present',None)['verdict'],'证据不足')
        for count in [True,-1,3,4.5]:
            with self.assertRaises(ValueError):
                self.result('V5','present',count)

    def test_single_frames_never_prove_entry_or_thirty_seconds(self):
        for scene in ['V1','V6']:
            self.assertEqual(self.result(scene)['verdict'],'证据不足')
        context={'temporalEvidence':True,'rule':{'verified':True,'line':[[.5,0],[.5,1]]}}
        self.assertEqual(self.result('V1',context=context,images=2)['verdict'],'支持')
        context={'temporalEvidence':True,'observation':{'stationarySeconds':29}}
        self.assertEqual(self.result('V6',context=context,images=3)['verdict'],'证据不足')
        context['observation']['stationarySeconds']=30
        self.assertEqual(self.result('V6',context=context,images=3)['verdict'],'支持')

    def test_failure_codes_distinguish_generation_and_validation(self):
        import json
        decode=json.JSONDecodeError('invalid','',0)
        self.assertEqual(self.review.review_error(decode,'validate',{'finished':False}),'REVIEW_OUTPUT_TRUNCATED')
        self.assertEqual(self.review.review_error(decode,'validate',{'finished':True}),'REVIEW_JSON_INVALID')
        self.assertEqual(self.review.review_error(ValueError('REVIEW_COUNT_CONFLICT'),'validate',{}),'REVIEW_COUNT_CONFLICT')
        self.assertEqual(self.review.review_error(ValueError('bad input'),'generate',{}),'MODEL_INFERENCE_FAILED')
        self.assertEqual(self.review.review_error(RuntimeError('CUDA illegal memory access'),'generate',{}),'CUDA_CONTEXT_LOST')
        self.assertEqual(self.review.review_error(ValueError('secret arbitrary error'),'validate',{}),'REVIEW_STRUCTURE_INVALID')

    def test_review_budgets_are_configurable_and_bounded(self):
        cfg=self.review.review_config({'dtype':'bfloat16','maxNewTokens':220,'taskTimeoutSeconds':50})
        self.assertEqual(cfg['dtype'],'bfloat16');self.assertEqual(cfg['maxNewTokens'],220)
        for config in [{'taskTimeoutSeconds':10},{'minPixels':999999},{'maxNewTokens':True}]:
            with self.assertRaises(ValueError):self.review.review_config(config)


if __name__ == '__main__':
    unittest.main()
