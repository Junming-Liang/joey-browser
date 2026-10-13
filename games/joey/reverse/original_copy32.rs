//! Lossless specialization of original 004ba132's unrolled 32-byte copy loop.
use runtime::{Context,Cont};
pub fn try_copy(ctx:&mut Context)->Option<Cont>{
 #[cfg(test)] if FORCE_SLOW.with(|flag|flag.get()){return None;}
 let source=ctx.cpu.regs.eax as usize;let destination=ctx.cpu.regs.ecx as usize;let count=ctx.cpu.regs.edx;
 if count==0||count>i32::MAX as u32||source<0x1000||destination<0x1000{return None;}
 let length=(count as usize).checked_mul(32)?;let source_end=source.checked_add(length)?;let destination_end=destination.checked_add(length)?;
 if source_end>ctx.memory.bytes.len()||destination_end>ctx.memory.bytes.len()||(source<destination_end&&destination<source_end){return None;}
 // Overlap keeps the original sequential dword writes (not memmove semantics).
 let last=ctx.memory.read::<u32>((source_end-4)as u32);
 ctx.memory.bytes.copy_within(source..source_end,destination);
 ctx.cpu.regs.eax=source_end as u32;ctx.cpu.regs.ecx=destination_end as u32;ctx.cpu.regs.edx=0;ctx.cpu.regs.edi=last;
 // Original final ADD ECX,32 then DEC EDX; retain all other flag bits.
 runtime::add((destination_end-32)as u32,32,&mut ctx.cpu.flags);
 runtime::dec(1u32,&mut ctx.cpu.flags);
 Some(Cont(crate::generated_copy::x4ba169))
}
#[cfg(test)] thread_local!{pub static FORCE_SLOW:std::cell::Cell<bool>=const{std::cell::Cell::new(false)};}
