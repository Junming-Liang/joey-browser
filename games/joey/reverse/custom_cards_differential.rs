//! Bounded native tests using real generated instructions, with explicit external-service stubs.
#![allow(dead_code)]
mod custom_cards;
mod generated;
mod reference;
use runtime::{Context, Cont};
extern crate self as host;
pub struct FakeHost;
static FAKE_HOST: FakeHost = FakeHost;
std::thread_local! { static PRESENTATIONS: std::cell::RefCell<Vec<(u32,u32)>> = const { std::cell::RefCell::new(Vec::new()) }; }
pub fn host() -> &'static FakeHost { &FAKE_HOST }
impl FakeHost {
    pub fn collectible_event(&self, internal:u32, side:u32) {
        PRESENTATIONS.with(|events|events.borrow_mut().push((internal,side)));
    }
}

const TEST: u32 = 0x10000;
const COLLECTION: u32 = 0xa53ccc;
const BATTLE: u32 = 0xa57840;
const FIELD: u32 = 0xa55d74;
const IDS: &[u8] = include_bytes!("../card_id.bin");
const PACKS: &[u8] = include_bytes!("../card_pack.bin");

fn legacy(internal: u32) -> u32 {
    if internal < 1115 { u16::from_le_bytes(IDS[internal as usize * 2..internal as usize * 2 + 2].try_into().unwrap()) as u32 }
    else if internal < 1120 { internal - 1115 + 1950 } else { 0xffff }
}

fn arg(ctx: &Context, index: u32) -> u32 { ctx.memory.read::<u32>(ctx.cpu.regs.esp + 4 + index * 4) }

pub fn stub(ctx: &mut Context, address: u32) -> Cont {
    let mut pop = 0;
    ctx.cpu.regs.eax = match address {
        0x4022e0 => legacy(arg(ctx, 0) & 0xffff),
        0x542220 => {assert_eq!(ctx.cpu.regs.ecx,0x5f2448);0x20000},
        0x402340 | 0x5c387c => panic!("ID fixture must already be initialized"),
        0x402460 => (0..1120).find(|&i| legacy(i) == (arg(ctx, 0) & 0xffff)).unwrap_or(0),
        0x402690 => 0, // Spell category for the bounded AI spell-selection fixtures.
        0x598c40 => u32::from(ctx.memory.read::<u8>(TEST + 0x1000 + (arg(ctx, 2) & 0xfff)) != 0),
        0x56d340 => {let side=arg(ctx,0)&1;let id=arg(ctx,1)&0xffff;
            (0..2).find(|i| legacy(ctx.memory.read::<u32>(0xa56434+side*0xd44+i*4)&0xfff)==id).unwrap_or(u32::MAX)}
        0x57e160 | 0x57e220 => u32::from(ctx.memory.read::<u8>(TEST+0x90)==0),
        0x5aef10 => {let n=ctx.memory.read::<u32>(TEST+0x94);ctx.memory.write::<u32>(TEST+0x94,n+1);
            u32::from(ctx.memory.read::<u8>(TEST+0x91)==0)}
        0x56b440 => u32::from(ctx.memory.read::<u8>(TEST + 0x1000 + (arg(ctx, 0) & 0xfff)) != 0),
        0x56d560 => u32::MAX,
        0x56d2c0 => u32::from(ctx.memory.read::<u32>(TEST+0xd0)==(arg(ctx,0)&1)+1),
        0x5675f0 | 0x56c460 | 0x5699c0 => 0,
        // Summon presentation/negation machines are explicit external boundaries;
        // the actual post-machine existence, face-up and completion code executes.
        0x5abd00 | 0x5ac870 | 0x5ac990 | 0x5acf10 | 0x5ad210 | 0x5ad350 => 1,
        0x598590 => 0,
        0x5bd2d0 => {let n=ctx.memory.read::<u32>(TEST+0xb0);ctx.memory.write::<u32>(TEST+0xb0,n+1);1},
        0x5699a0 | 0x56b220 | 0x56d790 | 0x56d8d0 | 0x56f6d0 | 0x56f9e0 | 0x56a780 | 0x56a810 => 0,
        0x5747e0 | 0x578390 => { let n=ctx.memory.read::<u32>(TEST+12);ctx.memory.write::<u32>(TEST+12,n+1);0 },
        0x5787f0 => {
            let side = arg(ctx,0); let amount = arg(ctx,1);
            ctx.memory.write::<u32>(TEST+0x20,side);ctx.memory.write::<u32>(TEST+0x24,amount);
            let n=ctx.memory.read::<u32>(TEST+0x28);ctx.memory.write::<u32>(TEST+0x28,n+1);0
        }
        0x5add60 | 0x5addc0 => {
            let field=FIELD+(arg(ctx,0)&1)*0xd44+arg(ctx,1)*0x90;
            let target=arg(ctx,2);let id=ctx.memory.read::<u32>(field)&0xfff;
            ctx.memory.write::<u32>(target,id|0x05010000);
            for offset in [4,8] {let value=ctx.memory.read::<u32>(field+0x20+offset);ctx.memory.write::<u32>(target+offset,value);}0
        }
        0x5be050 => arg(ctx,0)/2,
        0x44b970 => ctx.memory.read::<u32>(TEST),
        0x47da30 => {
            let owned=arg(ctx,0);let total=arg(ctx,1);
            ctx.memory.write::<u32>(owned,771);ctx.memory.write::<u32>(total,771);0
        }
        0x4024e0 => { let i=arg(ctx,0) as usize;if i<1115 {u16::from_le_bytes(PACKS[i*2..i*2+2].try_into().unwrap()) as u32}else{4} }
        0x5bea40 => 4,
        0x402980 => {pop=8;0}, // String allocation is deliberately rejected; this path is allowed by the original.
        0x54d580 => {pop=16;0},
        0x54d420 | 0x54d450 => 0,
        0x54d660 | 0x5be090 => {let n=ctx.memory.read::<u32>(TEST+0xc0);
            ctx.memory.write::<u32>(TEST+0xc0,n.wrapping_mul(10)+if address==0x5be090{2}else{3});0}
        0x4834a0 => { // Original reload boundary: simulate newly loaded quantities, with old seen flags absent.
            let n=ctx.memory.read::<u32>(TEST+0xc0);ctx.memory.write::<u32>(TEST+0xc0,n.wrapping_mul(10)+1);
            for i in 0..1120 {ctx.memory.write::<u16>(COLLECTION+i*2,7);}0
        }
        _ => panic!("Unexpected external function {address:x}"),
    };
    ctx.ret32(pop)
}

#[cfg(test)] mod tests {
    use super::*;
    use runtime::{Context, Memory};
    fn context(reference: bool) -> Context {
        let mut ctx=Context{cpu:Default::default(),thread_id:1,thread_handle:1,memory:Memory::leak_new(16<<20),
            blocks:if reference{reference::BLOCKS}else{generated::BLOCKS},cache:Default::default(),recent:[Context::return_from_x86;4]};
        let bytes=include_bytes!("../image-sections.bin");let word=|p:usize|u32::from_le_bytes(bytes[p..p+4].try_into().unwrap());
        let count=word(0);let mut p=4;
        for _ in 0..count {let address=word(p)as usize;let len=word(p+4)as usize;p+=8;ctx.memory.bytes[address..address+len].copy_from_slice(&bytes[p..p+len]);p+=len;}
        ctx.memory.write::<u8>(0x5f2478,1);
        for id in 0..1120 {ctx.memory.write::<u16>(0x20000+id*2,legacy(id)as u16);}
        ctx.memory.write::<u16>(0x20000+1120*2,0xbeef);
        ctx.cpu.regs.esp=0x900000;ctx
    }
    fn run(ctx:&mut Context,address:u32,args:&[u32])->u32 {
        let esp=ctx.cpu.regs.esp;
        for a in args.iter().rev(){ctx.push32(*a);}
        let target=ctx.cpu.regs.esp;ctx.push32(runtime::RETURN_FROM_X86_ADDR32);
        let next=ctx.indirect32(address);ctx.cpu_loop(next,target);ctx.cpu.regs.esp=esp;ctx.cpu.regs.eax
    }
    fn seed(ctx:&mut Context,value:u32){ctx.cpu.regs.ecx=0x5f25e8;let next=ctx.indirect32(0x55c0e0);ctx.call32_x86(next,vec![value]);}
    fn until(ctx:&mut Context,address:u32,stops:&[u32])->u32{
        let mut next=ctx.indirect32(address);
        for _ in 0..64 {
            for stop in stops {let f=ctx.blocks.iter().find(|(a,_)|a==stop).unwrap().1;
                if std::ptr::fn_addr_eq(next.0,f){return *stop;}}
            next=(next.0)(ctx);
        }
        panic!("Original result state did not reach a bounded test boundary")
    }
    fn battle(ctx:&mut Context,side:u32,att:u16,def:u16,attack:u32,defense:u32,position:bool,direct:bool,waboku:bool){
        ctx.memory.bytes[BATTLE as usize..BATTLE as usize+0x30].fill(0);
        ctx.memory.write::<u32>(BATTLE,side|((1-side)<<1)|if direct{4}else{0});
        let a=BATTLE+4+side*16;let d=BATTLE+20-side*16;
        ctx.memory.write::<u16>(a+2,att);ctx.memory.write::<u32>(a+4,attack);ctx.memory.write::<u32>(a+8,800);
        ctx.memory.write::<u16>(d,if position{0x20}else{0});ctx.memory.write::<u16>(d+2,def);
        ctx.memory.write::<u32>(d+4,defense);ctx.memory.write::<u32>(d+8,defense);
        for s in 0..2{ctx.memory.write::<u32>(0xa56430+s*0xd44,if waboku{0x400000}else{0});}
        ctx.cpu.regs=Default::default();ctx.cpu.regs.esp=0x900000;ctx.cpu.flags=runtime::Flags::from_bits_retain(0x200095);
    }
    fn result(ctx:&Context)->Vec<u8>{ctx.memory.bytes[BATTLE as usize..BATTLE as usize+0x24].to_vec()}
    fn ai(ctx:&mut Context,side:u32,att:u16,def:u16,attack:u32,defense:u32,position:bool)->(u16,i16){
        for(s,id,power,stance)in[(side,att,attack,false),(1-side,def,defense,position)]{
            let field=FIELD+s*0xd44;ctx.memory.write::<u32>(field,u32::from(id));ctx.memory.write::<u8>(field+6,u8::from(stance));
            ctx.memory.write::<u32>(field+0x24,power);ctx.memory.write::<u32>(field+0x28,power);
        }
        ctx.memory.write::<u32>(TEST+0x40,0);ctx.cpu.regs.esp=0x900000;
        run(ctx,0x5b0f40,&[side,0,0,TEST+0x40]);
        (ctx.memory.read::<u16>(TEST+0x40),ctx.memory.read::<i16>(TEST+0x42))
    }
    #[test] fn all_original_effect_and_direct_attack_paths_are_unchanged(){
        let mut a=context(false);let mut b=context(true);
        for id in 0..1115 {
            assert_eq!(run(&mut a,0x59dbe0,&[id]),run(&mut b,0x59dbe0,&[id]),"effect {id}");
            for s in 0..2 {let f=FIELD+s*0xd44;a.memory.write::<u32>(f,id);b.memory.write::<u32>(f,id);
                assert_eq!(run(&mut a,0x56bfd0,&[s,0]),run(&mut b,0x56bfd0,&[s,0]),"direct {id}");}
        }
        assert_eq!(run(&mut a,0x59dbe0,&[1115]),65);
    }
    #[test] fn real_id_getter_accepts_five_appended_rows_and_rejects_one_past_end(){
        let mut c=context(false);
        for id in 0..1120 {assert_eq!(run(&mut c,0x4022e0,&[id])&0xffff,legacy(id));}
        for id in [1120,2047,0xffff] {assert_eq!(run(&mut c,0x4022e0,&[id])&0xffff,0xffff);}
    }
    #[test] fn original_battle_and_ai_results_registers_flags_are_unchanged(){
        let mut a=context(false);let mut b=context(true);
        for side in 0..2 {for att in [1,186,984,559,755] {for def in [1,186,984] {for attack in [0,500,1500,2500] {for position in [false,true] {
            battle(&mut a,side,att,def,attack,1500,position,false,false);battle(&mut b,side,att,def,attack,1500,position,false,false);
            run(&mut a,0x5b8210,&[1]);run(&mut b,0x5b8210,&[1]);assert_eq!(result(&a),result(&b));
            assert_eq!(format!("{:?}",a.cpu.regs),format!("{:?}",b.cpu.regs));assert_eq!(a.cpu.flags,b.cpu.flags);
            assert_eq!(ai(&mut a,side,att,def,attack,1500,position),ai(&mut b,side,att,def,attack,1500,position));
        }}}}}
    }
    #[test] fn tea_resolves_original_win_flags_only_after_successful_effect(){
        let mut a=context(false);let mut b=context(true);
        for id in [559u16,1086,1115] {for side in 0..2 {for negate in [0u16,4] {for mode in [0u32,3] {
            for c in [&mut a,&mut b]{custom_cards::reset_duel(c);c.memory.write::<u32>(0x5f3294,mode);
                c.memory.write::<u16>(TEST+0x80,id);c.memory.write::<u16>(TEST+0x82,side);
                c.memory.write::<u16>(TEST+0x84,negate);c.memory.write::<u16>(TEST+0x86,side);
                c.memory.write::<u32>(TEST+0x28,0);c.memory.write::<u32>(0xa54e5c,0);
                c.memory.write::<u16>(0xa55d64,8000);c.memory.write::<u16>(0xa56aa8,8000);
                c.memory.write::<u16>(0xa577fa,0);c.memory.write::<u8>(0xa577f4,0);}
            PRESENTATIONS.with(|events|events.borrow_mut().clear());
            run(&mut a,0x584d00,&[TEST+0x80,0]);
            if id<1115 {run(&mut b,0x584d00,&[TEST+0x80,0]);assert_eq!(&a.memory.bytes[TEST as usize+0x20..TEST as usize+0x2c],&b.memory.bytes[TEST as usize+0x20..TEST as usize+0x2c]);}
            else {assert_eq!(a.memory.read::<u32>(TEST+0x28),0,"collectible no longer heals");}
            let win=id==1115&&negate==0&&mode!=3;
            if win {run(&mut a,0x584d00,&[TEST+0x80,0]);}
            PRESENTATIONS.with(|events|assert_eq!(*events.borrow(),if win{vec![(1115,u32::from(side))]}else{vec![]}));
            assert_eq!(run(&mut a,0x5bc050,&[]),u32::from(win));
            assert_eq!(a.memory.read::<u16>(0xa577fa)&0xc0,if win{if side==0{0x40}else{0x80}}else{0});
            assert_eq!(a.memory.read::<u8>(0xa577f4)&0x10,if win{0x10}else{0});
            for lp in [0xa55d64,0xa56aa8]{assert_eq!(a.memory.read::<u16>(lp),8000);}
        }}}}
    }
    #[test] fn original_summon_completion_rejects_sets_negated_summons_and_network(){
        let mut c=context(false);
        for id in 1116..1120 {for side in 0..2 {for kind in 1..=6 {for mode in [0,3] {for state in 0..4 {
            custom_cards::reset_duel(&c);c.memory.write::<u32>(0x5f3294,mode);
            c.memory.bytes[FIELD as usize..FIELD as usize+0x1a88].fill(0);
            c.memory.write::<u32>(0xa54e5c,side);c.memory.write::<u32>(0xa55080,side|0x4000);
            let f=FIELD+side*0xd44;
            c.memory.write::<u16>(f,id);c.memory.write::<u8>(f+6,if state==3{2}else{0});
            custom_cards::begin_flip(&c); // Capture before flip; state 3 was already face-up.
            c.memory.write::<u8>(f+6,if state==1{0}else{2});
            if state==2 {c.memory.write::<u16>(f,0);} // Original negation removes the attempted summon.
            c.memory.write::<u16>(0xa5508e,1|(kind<<2));c.memory.write::<u8>(0xa5508c,0);
            c.memory.write::<u16>(0xa577fa,0);c.memory.write::<u8>(0xa577f4,0);
            c.memory.write::<u16>(0xa55d64,8000);c.memory.write::<u16>(0xa56aa8,8000);
            PRESENTATIONS.with(|events|events.borrow_mut().clear());
            run(&mut c,0x5ab820,&[]);
            let expected=mode!=3&&state!=1&&state!=2&&(kind!=3||state!=3);
            if expected {custom_cards::resolved_summon(&c);}
            PRESENTATIONS.with(|events|assert_eq!(*events.borrow(),if expected{vec![(u32::from(id),side)]}else{vec![]}));
            assert_eq!(run(&mut c,0x5bc050,&[]),u32::from(expected),"id={id} side={side} kind={kind} mode={mode} state={state}");
            assert_eq!(c.memory.read::<u16>(0xa577fa)&0xc0,if expected{0x40}else{0});
            assert_eq!(c.memory.read::<u16>(0xa55d64),8000);assert_eq!(c.memory.read::<u16>(0xa56aa8),8000);
            custom_cards::reset_duel(&c);c.memory.write::<u16>(0xa577fa,0);c.memory.write::<u8>(0xa577f4,0);
            assert_eq!(run(&mut c,0x5bc050,&[]),0,"winner cannot survive next duel reset");
        }}}}}
    }
    #[test] fn network_handshake_rejects_both_deck_regions_without_victory_or_send(){
        let mut c=context(false);c.memory.write::<u32>(0x5f3294,3);
        for (base,count) in [(0xa54e60,0xa54f3c),(0xa54f1e,0xa54f40)] {for id in 1115..1120 {
            c.memory.write::<u16>(0xa54f3c,0);c.memory.write::<u16>(0xa54f40,0);
            c.memory.write::<u16>(count,1);c.memory.write::<u16>(base,id);c.memory.write::<u16>(0xa577fa,0);
            c.memory.write::<u8>(0xa577f4,0);c.memory.write::<u32>(TEST+0xb0,0);
            assert_eq!(run(&mut c,0x5bdb40,&[]),1);assert_eq!(c.memory.read::<u16>(0xa577fa),0x20);
            assert_eq!(c.memory.read::<u8>(0xa577f4),0);assert_eq!(c.memory.read::<u32>(TEST+0xb0),0);
        }}
        c.memory.write::<u16>(0xa54f3c,80);c.memory.write::<u16>(0xa54f40,15);
        for i in 0..80{c.memory.write::<u16>(0xa54e60+i*2,186);}for i in 0..15{c.memory.write::<u16>(0xa54f1e+i*2,186);}
        assert!(!custom_cards::reject_network_deck(&mut c));
        c.memory.write::<u16>(0xa54f3c,81);assert!(custom_cards::reject_network_deck(&mut c));
    }
    #[test] fn collectible_result_matches_original_exodia_outcome_for_either_player(){
        let mut a=context(false);let mut b=context(true);
        for local in 0..2 {for winner in 0..2 {
            for c in [&mut a,&mut b] {custom_cards::reset_duel(c);c.memory.write::<u32>(0x5f3294,0);
                c.memory.write::<u32>(0xa54e5c,local);c.memory.write::<u16>(0xa577fa,0x2101);
                c.memory.write::<u8>(0xa577f4,5);c.memory.write::<u16>(0xa55d6c,0);c.memory.write::<u16>(0xa56ab0,0);
                c.memory.write::<u16>(0xa55d64,8000);c.memory.write::<u16>(0xa56aa8,8000);}
            b.memory.write::<u32>(TEST+0xd0,winner+1);
            a.memory.write::<u16>(TEST+0x80,1115);a.memory.write::<u16>(TEST+0x82,winner as u16);
            a.memory.write::<u16>(TEST+0x84,0);a.memory.write::<u16>(TEST+0x86,winner as u16);
            run(&mut a,0x584d00,&[TEST+0x80]);assert_eq!(run(&mut a,0x5bc050,&[]),run(&mut b,0x5bc050,&[]));
            for addr in [0xa577fa,0xa577f4,0xa55d64,0xa56aa8]{assert_eq!(a.memory.read::<u16>(addr),b.memory.read::<u16>(addr));}
            assert_eq!(a.memory.read::<u16>(0xa55d6c)&0x200,0,"do not request fake Exodia animation");
        }}
    }
    #[test] fn superseded_four_monster_abilities_are_absent(){
        let mut c=context(false);
        for side in 0..2 {
            battle(&mut c,side,1117,1116,2500,2000,true,false,false);run(&mut c,0x5b8210,&[1]);
            let d=BATTLE+20-side*16;
            assert_ne!(c.memory.read::<u16>(d)&0x10,0,"rice has no battle immunity");
            assert_eq!(c.memory.read::<u32>(d+12),0,"leek has no piercing");
            battle(&mut c,side,186,1119,1500,2000,true,false,false);run(&mut c,0x5b8210,&[1]);
            assert_eq!(c.memory.read::<u32>(BATTLE+4+side*16+12),500,"cactus has no damage multiplier");
            c.memory.write::<u32>(FIELD+side*0xd44,1118);assert_eq!(run(&mut c,0x56bfd0,&[side,0]),0,"monkey has no direct attack");
        }
    }
    #[test] fn original_rng_rewards_only_custom_cards_distinct_and_deterministic(){
        let mut a=context(false);let mut b=context(false);let object=TEST+0x200;
        for match_game in [0,1] {for mask in 0..32 {for c in [&mut a,&mut b]{
            c.memory.write::<u32>(TEST,match_game);c.memory.bytes[object as usize..object as usize+0x40].fill(0);
            for i in 0..5{c.memory.write::<u16>(COLLECTION+(1115+i)*2,if mask&(1<<i)!=0{3}else{0});}
            seed(c,12345+mask);c.cpu.regs.ecx=object;run(c,0x445640,&[]);
        }
        assert_eq!(&a.memory.bytes[object as usize..object as usize+0x40],&b.memory.bytes[object as usize..object as usize+0x40]);
        let count=a.memory.read::<u32>(object+0x1c);assert_eq!(count,if match_game==0{1}else{3});let mut got=Vec::new();
        for i in 0..count{let id=a.memory.read::<u32>(object+0x20+i*4);assert!((1115..1120).contains(&id));assert!(!got.contains(&id));got.push(id);
            assert_eq!(a.memory.read::<u32>(object+0x2c+i*4),u32::from(mask&(1<<(id-1115))==0));
            let before=a.memory.read::<u16>(COLLECTION+id*2);run(&mut a,0x5be830,&[id]);assert_eq!(a.memory.read::<u16>(COLLECTION+id*2),before+1);
        }
        }}
    }
    #[test] fn seen_reload_retains_new_bits_without_overrunning_original_stack(){
        let mut c=context(false);let stack=c.cpu.regs.esp;
        for mask in 0..32 {
            for i in 0..1120 {c.memory.write::<u16>(COLLECTION+i*2,if i<1115{0x4003}else if mask&(1<<(i-1115))!=0{0x4003}else{3});}
            c.memory.write::<u32>(stack+4,0x1234abcd);run(&mut c,0x47dce0,&[]);
            assert_eq!(c.cpu.regs.esp,stack);assert_eq!(c.memory.read::<u32>(stack+4),0x1234abcd);
            for i in 0..1120 {assert_eq!(c.memory.read::<u16>(COLLECTION+i*2),7|if i<1115||mask&(1<<(i-1115))!=0{0x4000}else{0},"mask {mask}, card {i}");}
        }
    }
    #[test] fn cpu_tries_tea_only_after_original_healing_priority_fails(){
        let row=TEST+0x300;
        let mut a=context(false);let mut b=context(true);
        let keto=(0..1115).find(|&i|legacy(i)==341).unwrap();
        for side in 0..2 {for original in [false,true] {for tea in [false,true] {for field in [false,true] {
            for denied in 0..4 {
                for c in [&mut a,&mut b] {
                    c.memory.bytes[FIELD as usize..FIELD as usize+0x1a88].fill(0);
                    c.memory.bytes[0xa57800..0xa57810].fill(0);
                    c.memory.write::<u32>(row,341);c.memory.write::<u32>(row+4,0x5b48d0);
                    c.memory.write::<u8>(TEST+0x90,u8::from(denied==1));
                    c.memory.write::<u8>(TEST+0x91,u8::from(denied==2));
                    c.memory.write::<u8>(TEST+0x1000+1115,u8::from(denied==3));
                    c.memory.write::<u32>(TEST+0x94,0);
                    if field {
                        if original{c.memory.write::<u32>(FIELD+side*0xd44+5*0x90,keto);}
                        if tea{c.memory.write::<u32>(FIELD+side*0xd44+6*0x90,1115);}
                    } else {
                        if original{c.memory.write::<u32>(0xa56434+side*0xd44,keto);}
                        if tea{c.memory.write::<u32>(0xa56438+side*0xd44,1115);}
                    }
                    c.cpu.regs=Default::default();c.cpu.regs.esp=0x900000;
                    c.cpu.regs.ebx=0x11111111;c.cpu.regs.ebp=0x22222222;c.cpu.regs.esi=0x33333333;c.cpu.regs.edi=0x44444444;
                }
                let old=run(&mut b,0x5b5e00,&[side,row]);let new=run(&mut a,0x5b5e00,&[side,row]);
                assert_eq!(new,u32::from((original&&denied!=1&&denied!=2)||(!original&&tea&&denied==0)),
                    "side={side} original={original} tea={tea} field={field} denied={denied}");
                if old!=0||!tea {
                    assert_eq!(new,old);assert_eq!(&a.memory.bytes[0xa57800..0xa57810],&b.memory.bytes[0xa57800..0xa57810]);
                    assert_eq!(format!("{:?}",a.cpu.regs),format!("{:?}",b.cpu.regs));assert_eq!(a.cpu.flags,b.cpu.flags);
                    assert_eq!(a.memory.read::<u32>(TEST+0x94),b.memory.read::<u32>(TEST+0x94));
                }
                if new!=0 {assert_eq!(a.memory.read::<u16>(0xa57802),if original{keto as u16}else{1115});}
                assert_eq!((a.cpu.regs.ebx,a.cpu.regs.ebp,a.cpu.regs.esi,a.cpu.regs.edi,a.cpu.regs.esp),
                    (0x11111111,0x22222222,0x33333333,0x44444444,0x900000));
            }
        }}}}
        // A prohibition specific to Dian Keto must not prohibit the distinct tea ID.
        a.memory.bytes[FIELD as usize..FIELD as usize+0x1a88].fill(0);
        a.memory.write::<u32>(0xa56434,keto);a.memory.write::<u32>(0xa56438,1115);
        a.memory.write::<u8>(TEST+0x1000+keto,1);a.memory.write::<u8>(TEST+0x1000+1115,0);
        a.memory.write::<u8>(TEST+0x90,0);a.memory.write::<u8>(TEST+0x91,0);
        assert_eq!(run(&mut a,0x5b5e00,&[0,row]),1);assert_eq!(a.memory.read::<u16>(0xa57802),1115);
        // Other priority IDs do not gain a hidden tea attempt.
        a.memory.write::<u32>(row,340);a.memory.write::<u32>(TEST+0x94,0);
        assert_eq!(run(&mut a,0x5b5e00,&[0,row]),0);assert_eq!(a.memory.read::<u32>(TEST+0x94),0);
    }
    #[test] fn original_reward_claim_keeps_reload_award_checksum_save_order_in_network_mode(){
        let mut c=context(false);let object=TEST+0x200;
        for mode in [0,1,3] {for count in [1,3] {
            c.memory.write::<u32>(0x5f3294,mode);c.memory.write::<u32>(TEST+0xc0,0);
            c.memory.write::<u32>(object+0x1c,count);c.memory.write::<u32>(object+0x38,11);
            for i in 0..count {c.memory.write::<u32>(object+0x20+i*4,1115+i);}
            c.memory.bytes[0xa54daf..0xa54db8].fill(0x56);
            c.cpu.regs.ecx=object;run(&mut c,0x445840,&[]);
            assert_eq!(c.memory.read::<u32>(TEST+0xc0),123);
            assert_eq!(c.memory.read::<u8>(0xa54dad),11);
            for id in 0..1120 {assert_eq!(c.memory.read::<u16>(COLLECTION+id*2),
                if id>=1115&&id<1115+count{8}else{7},"mode={mode} count={count} id={id}");}
            assert_eq!(&c.memory.bytes[0xa54daf..0xa54db8],&[0x56;9],"claim must not change CPU progression");
            assert_eq!(c.memory.read::<u32>(0x5f3294),mode);
        }}
    }
    #[test] fn network_reward_gate_requires_normal_win_and_original_state_prevents_reallocation(){
        let mut a=context(false);let mut b=context(true);let object=TEST+0x400;
        for mode in 0..8 {for result in 0..4 {for aborted in [false,true] {
            for c in [&mut a,&mut b] {
                c.cpu.regs=Default::default();c.cpu.regs.esp=0x900000;c.cpu.regs.ebp=object;
                c.memory.write::<u32>(0x5f3294,mode);c.memory.write::<u32>(0x5f3254,result);
                c.memory.write::<u8>(0xa54e5c,if aborted{0x40}else{0});c.memory.write::<u32>(object+0x14,1);
            }
            let new=until(&mut a,0x4475d1,&[0x54a1d0,0x4476eb]);
            let old=until(&mut b,0x4475d1,&[0x54a1d0,0x4476eb]);
            assert_eq!(new,if result==1&&!aborted{0x54a1d0}else{0x4476eb});
            if mode!=3||result!=1||aborted {
                assert_eq!(new,old);assert_eq!(format!("{:?}",a.cpu.regs),format!("{:?}",b.cpu.regs));assert_eq!(a.cpu.flags,b.cpu.flags);
            } else {assert_eq!(old,0x4476eb);}
            assert_eq!(a.memory.read::<u32>(0x5f3294),mode);
            if new==0x54a1d0 {
                assert_eq!(a.memory.read::<u32>(object+0x14),2,"advance before creating reward window");
                a.cpu.regs.esp=0x900000;a.cpu.regs.ebx=0;a.cpu.regs.ebp=object;
                // The original child list is empty after completion: next tick exits instead of creating again.
                a.memory.write::<u32>(object+0x20,0);a.memory.write::<u32>(object+0x24,0);
                assert_eq!(until(&mut a,0x4475d1,&[0x54a1d0,0x4476eb]),0x4476eb);
            }
        }}}
        // In network mode, original animation completion still gates the first allocation.
        a.cpu.regs.esp=0x900000;a.cpu.regs.ebp=object;a.cpu.regs.ebx=0;
        a.memory.write::<u32>(0x5f3294,3);a.memory.write::<u32>(0x5f3254,1);a.memory.write::<u8>(0xa54e5c,0);
        a.memory.write::<u32>(object+0x14,0);a.memory.write::<u32>(object+0x2c,TEST+0x500);
        a.memory.write::<u32>(TEST+0x504,0x402690); // Original method result: finished.
        assert_eq!(until(&mut a,0x4475d1,&[0x54a1d0,0x4476eb,0x4476f5]),0x4476f5);
        assert_eq!(a.memory.read::<u32>(object+0x14),1);
        assert_eq!(until(&mut a,0x4475d1,&[0x54a1d0,0x4476eb,0x4476f5]),0x54a1d0);
    }
}
