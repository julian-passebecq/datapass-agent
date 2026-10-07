import * as vscode from 'vscode';
import {SessionStore} from '../sessions/store';
import {AgentSessionSnapshot} from '../model';
import {bounded} from '../util/redact';
import {agentLensContext} from '../interop';
type Entry={section:string}|{session:AgentSessionSnapshot}|{label:string;command?:string;key?:string};
export class Analyzer implements vscode.TreeDataProvider<Entry>,vscode.Disposable {
  private changed=new vscode.EventEmitter<Entry|undefined>();
  readonly onDidChangeTreeData=this.changed.event;
  private sub:{dispose():void};
  constructor(private store:SessionStore,private lensAvailable:()=>boolean){this.sub=store.onDidChange(()=>this.changed.fire(undefined));}
  dispose(){this.sub.dispose();this.changed.dispose();}
  getTreeItem(entry:Entry):vscode.TreeItem {
    if('section'in entry)return new vscode.TreeItem(entry.section,vscode.TreeItemCollapsibleState.Expanded);
    if('session'in entry){const s=entry.session,item=new vscode.TreeItem(bounded(s.title??s.sessionId,120),vscode.TreeItemCollapsibleState.Collapsed);
      item.description=`${s.provider}${s.isWorker?' worker':''} · ${s.status}`;item.tooltip=bounded(s.lastAction??s.statusReason,500);
      item.iconPath=new vscode.ThemeIcon(s.status==='NEEDS_INPUT'?'bell':s.status==='RUNNING'?'pulse':'circle-outline');return item;}
    const item=new vscode.TreeItem(bounded(entry.label,500));if(entry.command)item.command={command:entry.command,title:entry.label,arguments:entry.key?[entry.key]:[]};return item;
  }
  getChildren(entry?:Entry):Entry[] {
    if(!entry)return ['ACTIVE','ATTENTION','RECENT','EXPORT'].map(section=>({section}));
    if('session'in entry){const s=entry.session;return [
      {label:`Project: ${s.cwd??'UNKNOWN'}`},{label:`Action: ${s.lastAction??'UNKNOWN'}`},
      {label:`Context: ${s.usage?.contextTokens??'UNKNOWN'}`},
      {label:`Verification: ${s.tests.at(-1)?.outcome??'UNKNOWN'} ${s.tests.at(-1)?.command??''}`},
      {label:`Files: ${s.changedFiles.length} · Commits: ${s.commits.length}`},
      {label:'Open session',command:'agent.openSession',key:s.key},
      ...(['worktree','change','commit','file']as const).filter(action=>this.lensAvailable()&&agentLensContext(s,action)).map(action=>({label:({worktree:'Open worktree in Lens',change:'Inspect change in Lens',commit:'Open commit in Lens',file:'Open changed file in Lens'})[action],command:({worktree:'agent.openInTern',change:'agent.inspectChangeInLens',commit:'agent.openCommitInLens',file:'agent.openChangedFileInLens'})[action],key:s.key})),
      {label:'Export selected session',command:'agent.exportSelection',key:s.key}];}
    if(!('section'in entry))return [];
    const all=this.store.all();
    if(entry.section==='EXPORT')return [{label:'Choose sessions / group / project',command:'agent.exportSelection'}];
    const selected=all.filter(s=>entry.section==='ACTIVE'?['RUNNING','NEEDS_INPUT','IDLE'].includes(s.status):entry.section==='RECENT'?s.status==='ENDED':s.status==='NEEDS_INPUT'||s.status==='UNKNOWN'||s.dirty||s.tests.at(-1)?.outcome==='FAIL'||!!(s.usage?.contextWindow&&(s.usage.contextTokens??0)/s.usage.contextWindow>0.9));
    const entries:Entry[]=selected.slice(0,30).map(session=>({session}));
    if(entry.section==='ATTENTION')for(const p of this.store.providerStates)if(!p.detected)entries.push({label:`${p.provider}: collector unavailable / UNKNOWN`});
    return entries.length?entries:[{label:this.store.lastStats?'No sessions in this section':'Discovering provider observations…'}];
  }
}
