const themes=[
 ['一饮天下凉','战意归零，胜负已定','茶'],
 ['万年不散席','回合被年糕黏住，对手等不到下一回合','糕'],
 ['一葱两断','斩断败局，只留胜局','斩'],
 ['妙手空空','把对手的胜利偷到自己这边','夺'],
 ['万刺归宗','所有敌意沿尖刺原路奉还','刺']
];
export function createCollectibleEffects({container,networkSelection,probe={}}){
 let closed=false,active;
 Object.assign(probe,{played:0,rejected:0});
 const finish=()=>{if(!active)return;const old=active;active=null;clearTimeout(old.timer);try{old.node?.remove();}catch{}old.resolve(1);};
 return {
  collectible_event(internal,side){
   if(closed||networkSelection&&networkSelection.mode!=='single'||!Number.isInteger(internal)||internal<1115||internal>1119||![0,1].includes(side)){probe.rejected++;return 1;}
   finish();
   return new Promise(resolve=>{
    active={resolve,timer:0,node:null};
    try{
     const [title,text,symbol]=themes[internal-1115],node=document.createElement('div');node.className='collectible-effect';node.dataset.theme=String(internal);node.setAttribute('role','status');
     const mark=document.createElement('span'),heading=document.createElement('strong'),body=document.createElement('span');mark.className='collectible-effect-mark';mark.textContent=symbol;heading.textContent=title;body.textContent=text;node.append(mark,heading,body);
     active.node=node;container.append(node);probe.played++;active.timer=setTimeout(finish,750);
    }catch{finish();}
   });
  },
  close(){closed=true;finish();}
 };
}
