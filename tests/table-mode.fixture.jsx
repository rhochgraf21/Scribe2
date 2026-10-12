// Test-only caption input. Not included in the production build.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CaptionSetup } from '../src/browser/CaptionSetup';
import { renameSpeaker } from '../src/browser/speaker-names';
import { TableMode } from '../src/browser/TableMode';
import '../src/styles.css';
function Fixture() {
 const [session,setSession]=useState({id:'test-1',segments:[]});
 const [holding,setHolding]=useState(false), [held,setHeld]=useState(null);
 const [chooseMode,setChooseMode]=useState(false);
 const [active,setActive]=useState(true);
 window.tableQA={showModeChoice:()=>setChooseMode(true),
  append:(speaker,text)=>setSession(s=>({...s,segments:[...s.segments,{id:`word-${s.segments.length}`,speaker,text}]})),
  reset:()=>setSession(s=>({id:s.id+'-next',segments:[]})),
  hold:()=>{setHeld(structuredClone(session));setHolding(true);},resume:()=>setHolding(false),setActive,
 };
 if (chooseMode) return <main className="workspace setup-only"><CaptionSetup phase="listening" status="Microphone on" onChooseMode={mode=>{window.chosenMode=mode;setChooseMode(false);}} onStop={()=>setChooseMode(false)}/></main>;
 return <main className="app-shell"><div className="workspace"><section className="caption-panel table-mode-panel"><div className="caption-panel-header">Conversation header</div><div className="reading-toolbar">Aa 28</div><TableMode onRename={(id,name)=>{setSession(s=>renameSpeaker(s,id,name));setHeld(s=>s?renameSpeaker(s,id,name):s);}} session={session} live holding={holding} held={held} size={24} announce={false} onReturn={()=>setHolding(false)} active={active}/></section></div></main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
