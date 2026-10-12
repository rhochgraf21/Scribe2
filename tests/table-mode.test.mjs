import test from 'node:test';
import assert from 'node:assert/strict';
import { bindSeat, filterSession, makeSeats, mentionAlerts, namedSession } from '../src/browser/table-mode.js';
test('voice matches cannot move to another seat implicitly', () => {
 const seats = bindSeat(bindSeat(makeSeats(), 2, 1, 'Alice'), 3, 1, 'Bob');
 assert.equal(seats[1].speaker, '1'); assert.equal(seats[2].speaker, null);
 assert.deepEqual(seats.map(s => [s.x,s.y]), makeSeats().map(s => [s.x,s.y]));
});
test('followed captions include only confirmed speakers, including partial runs', () => {
 const session = { segments: [{speaker:1,text:'Hello'},{speaker:2,text:'Other'},{speaker:null,text:'Unknown'}], partial:'Unknown', partialRuns:[{speaker:1,text:'Yes'},{speaker:null,text:'Maybe'}] };
 const filtered = filterSession(namedSession(session, bindSeat(makeSeats(), 2, 1, 'Alice')), new Set(['1']));
 assert.equal(filtered.speakers[1], 'Alice'); assert.deepEqual(filtered.segments, [session.segments[0]]); assert.equal(filtered.partial, ''); assert.equal(filtered.partialRuns.length, 1);
});
test('mentions match whole names across words, ignore followed speakers and support aliases', () => {
 const session = {segments:[{id:'a',speaker:1,text:'Clark'},{id:'b',speaker:2,text:'Hi'},{id:'c',speaker:2,text:'Mary'},{id:'d',speaker:2,text:'Jane,'},{id:'e',speaker:3,text:'Clarkson'}]};
 const alerts = mentionAlerts(session, 'Clark, Mary Jane', new Set(['1']));
 assert.equal(alerts.length,1); assert.equal(alerts[0].text,'Hi Mary Jane,');
 assert.deepEqual(mentionAlerts(session, ' ', new Set()),[]);
 assert.equal(mentionAlerts({segments:[{id:'a',speaker:null,text:'Hey CLARK!'}]}, 'Clark', new Set()).length,1);
});
test('mention identity survives growing caption revisions for dismissals', () => {
 const session = {segments:[{id:'a',speaker:2,text:'Clark'}]};
 const key=mentionAlerts(session,'Clark',new Set())[0].key;
 session.segments.push({id:'b',speaker:2,text:'are you joining?'});
 assert.equal(mentionAlerts(session,'Clark',new Set())[0].key,key);
});

test('seat count changes preserve existing identities, positions and self; new seats are empty', async () => {
 const { resizeSeats } = await import('../src/browser/table-mode.js');
 let seats = bindSeat(bindSeat(makeSeats(),1,4,'Clark'),2,1,'Alice');
 seats[1] = {...seats[1],x:21,y:64};
 const original = structuredClone(seats);
 const grown = resizeSeats(seats,8,5);
 assert.deepEqual(grown.slice(0,4),original);
 assert.equal(grown.filter(s=>s.self).length,1);
 assert.ok(grown.slice(4).every(s=>!s.name && !s.speaker));
 const shrunk = resizeSeats(grown,2,9);
 assert.deepEqual(shrunk, original.slice(0,2));
 const regrown = resizeSeats(shrunk,4,9);
 assert.deepEqual(regrown.slice(0,2),shrunk);
 assert.deepEqual(regrown.slice(2).map(s=>s.id),[9,10]);
 assert.equal(resizeSeats(seats,99,5).length,8);
 assert.equal(resizeSeats(seats,-10,5).length,2);
 assert.equal(resizeSeats(seats,NaN,5),seats);
});
test('self-alert suppression applies to group, selection, unknown attribution and rematched own voices', async () => {
 const { tableMentionAlerts } = await import('../src/browser/table-mode.js');
 const session = {segments:[{id:'a',speaker:4,text:'Clark'},{id:'b',speaker:2,text:'Clark'},{id:'c',speaker:null,text:'Clark'},{id:'d',speaker:5,text:'Clark'}]};
 let seats=makeSeats();
 assert.deepEqual(tableMentionAlerts(session,'Clark',seats,new Set()),[]);
 seats=bindSeat(seats,1,4,'Clark');
 assert.deepEqual(tableMentionAlerts(session,'Clark',seats,new Set()).map(a=>a.speaker),[2,5]);
 assert.deepEqual(tableMentionAlerts(session,'Clark',seats,new Set(['2'])).map(a=>a.speaker),[5]);
 seats=bindSeat(seats,1,5,'Clark');
 assert.deepEqual(tableMentionAlerts(session,'Clark',seats,new Set(),['4','5']).map(a=>a.speaker),[2]);
});
test('another person cannot take the own-seat voice, including numeric IDs', () => {
 const seats=bindSeat(makeSeats(),1,4,'Clark');
 assert.equal(bindSeat(seats,2,4,'Alice'),seats);
 assert.equal(bindSeat(seats,2,'4','Alice'),seats);
 assert.equal(bindSeat(seats,99,5,'Missing'),seats);
 assert.equal(bindSeat(seats,2,null,'Alice'),seats);
});

test('matching ignores delayed old attribution and waits for unambiguous fresh speech', async () => {
 const { freshVoiceCandidate } = await import('../src/browser/table-mode.js');
 const baseline=new Map([['old', '']]);
 assert.equal(freshVoiceCandidate([{id:'old',speaker:1,text:'Old'}],baseline),'');
 const words=[{id:'a',speaker:3,text:'Hello'},{id:'b',speaker:3,text:'my'},{id:'c',speaker:3,text:'name'}];
 assert.equal(freshVoiceCandidate(words,baseline),'3');
 assert.equal(freshVoiceCandidate(words.slice(0,1),baseline),'');
 assert.equal(freshVoiceCandidate([...words,{id:'d',speaker:2,text:'Interrupted'}],baseline),'');
});
