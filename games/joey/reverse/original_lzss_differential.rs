mod original_lzss;
#[path="reference.rs"] mod generated;
mod original_copy32;
#[path="reference_copy.rs"] mod generated_copy;
#[cfg(test)] mod tests {
 use super::*;
 use runtime::{Context,Memory};
 fn context()->Context {Context{cpu:Default::default(),thread_id:1,thread_handle:1,memory:Memory::leak_new(16<<20),blocks:&[(0xfffffffe,Context::return_from_x86)],cache:Default::default(),recent:[Context::return_from_x86;4]}}
 fn setup(ctx:&mut Context,input:&[u8],size:usize,alias:bool) {
  ctx.memory.bytes.fill(0xa7);ctx.cpu.regs=Default::default();ctx.cpu.flags=runtime::Flags::from_bits_retain(0x200095);
  let stack=0x8000u32;let object=0x10000u32;let source=0x20000u32;let output=if alias{source+1}else{0x800000};
  ctx.cpu.regs.esp=stack;ctx.cpu.regs.ebx=object;ctx.cpu.regs.esi=0xfee;ctx.cpu.regs.edx=source;ctx.cpu.regs.ebp=output;ctx.cpu.regs.edi=object+4117;
  for i in 0..5 {ctx.memory.write::<u32>(stack+4*i,0x3450+i);}
  ctx.memory.write::<u32>(stack+16,object);ctx.memory.write::<u32>(stack+20,0xfffffffe);ctx.memory.write::<u32>(stack+24,source);ctx.memory.write::<u32>(stack+28,output);ctx.memory.write::<u32>(stack+32,size as u32);ctx.memory.write::<u32>(stack+36,0);
  ctx.memory.bytes[object as usize+4..object as usize+4117].fill(0);
  ctx.memory.bytes[source as usize..source as usize+input.len()].copy_from_slice(input);
 }
 fn run(ctx:&mut Context,slow:bool) {
  original_lzss::FORCE_SLOW.with(|flag|flag.set(slow));
  let mut continuation=runtime::Cont(generated::x54a05b);
  while ctx.cpu.regs.esp!=0x8000+40 {continuation=(continuation.0)(ctx);}
 }
 fn compare(a:&mut Context,b:&mut Context,input:&[u8],size:usize,alias:bool){
  setup(a,input,size,alias);setup(b,input,size,alias);run(a,false);run(b,true);
  let differences:Vec<_>=a.memory.bytes.iter().zip(b.memory.bytes.iter()).enumerate().filter(|(_, (x,y))|x!=y).take(12).map(|(i,(x,y))|(i,*x,*y)).collect();
  assert!(differences.is_empty(),"memory differs, size={size}, alias={alias}, first={differences:x?}");
  assert_eq!(a.cpu.regs.edx,b.cpu.regs.edx,"source cursor differs");
  assert_eq!(format!("{:?}",a.cpu.regs),format!("{:?}",b.cpu.regs),"registers differ after original epilogue");
  assert_eq!(a.cpu.flags,b.cpu.flags,"flags differ after original epilogue");
  // Other temporary registers are overwritten by the unmodified epilogue.
  // Its first XOR defines all observed arithmetic flags in both executions.
 }
 #[test] fn actual_original_images_match_memory_and_consumed_input(){
  let data=include_bytes!("../corpus.bin");let count=u32::from_le_bytes(data[..4].try_into().unwrap());let mut position=4;let mut a=context();let mut b=context();
  for _ in 0..count{let size=u32::from_le_bytes(data[position..position+4].try_into().unwrap())as usize;let len=u32::from_le_bytes(data[position+4..position+8].try_into().unwrap())as usize;position+=8;compare(&mut a,&mut b,&data[position..position+len],size,false);position+=len;}
  assert_eq!(position,data.len());
 }
 #[test] fn terminal_literal_reference_ring_overlap_and_alias_fallback(){
  let mut a=context();let mut b=context();
  for size in 1..=8 {compare(&mut a,&mut b,&[255,0,1,2,3,4,5,6,7],size,false);}
  for size in 1..=18 {compare(&mut a,&mut b,&[0,0,15],size,false);}
  // Overlapping ring references read bytes written earlier in the same token.
  compare(&mut a,&mut b,&[1,65,0xee,0xff],19,false);
  compare(&mut a,&mut b,&[255,1,2,3,4,5,6,7,8],2,true);
  original_lzss::FORCE_SLOW.with(|flag|flag.set(false));
  setup(&mut a,&[255,1,2,3,4,5,6,7,8],2,true);
  assert!(original_lzss::try_decode(&mut a).is_none(),"input/output alias must use original decoder");
  setup(&mut a,&[255,1,2,3,4,5,6,7,8],2,false);
  assert!(original_lzss::try_decode(&mut a).is_some(),"normal entry must actually use specialization");
 }
 #[test] fn corpus_timing(){
  let data=include_bytes!("../corpus.bin");let count=u32::from_le_bytes(data[..4].try_into().unwrap());let mut a=context();let mut measurements=Vec::new();
  for round in 0..4 {for slow in [round%2==0,round%2!=0]{let mut position=4;let mut duration=std::time::Duration::ZERO;let mut raw=0usize;
   for _ in 0..count{let size=u32::from_le_bytes(data[position..position+4].try_into().unwrap())as usize;let len=u32::from_le_bytes(data[position+4..position+8].try_into().unwrap())as usize;position+=8;setup(&mut a,&data[position..position+len],size,false);let started=std::time::Instant::now();run(&mut a,slow);duration+=started.elapsed();raw+=size;position+=len;}
   measurements.push((slow,duration.as_micros()));println!("CORPUS_TIMING round={round} slow={slow} images={count} rawBytes={raw} micros={}",duration.as_micros());
  }}
  // Timings are evidence, not a machine-dependent pass/fail threshold.
  assert_eq!(measurements.len(),8);
 }
 #[test] fn bulk_copy_matches_original_registers_flags_and_overlapping_writes(){
  let mut a=context();let mut b=context();
  for count in [1,2,3,11,64,4096,60000] {for delta in [-64isize,-4,0,4,64,2<<20]{
   let source=0x10000usize;let destination=(source as isize+delta)as usize;
   for slow in [false,true]{let ctx=if slow{&mut b}else{&mut a};for(i,byte)in ctx.memory.bytes.iter_mut().enumerate(){*byte=(i.wrapping_mul(173)^i>>8)as u8;}
    ctx.cpu.regs=Default::default();ctx.cpu.regs.eax=source as u32;ctx.cpu.regs.ecx=destination as u32;ctx.cpu.regs.edx=count;ctx.cpu.regs.edi=0x1234;ctx.cpu.flags=runtime::Flags::from_bits_retain(0x200c95);
    original_copy32::FORCE_SLOW.with(|flag|flag.set(slow));let mut next=runtime::Cont(generated_copy::x4ba132);
    while !std::ptr::fn_addr_eq(next.0,generated_copy::x4ba169 as runtime::ContFn){next=(next.0)(ctx);}
   }
   assert!(a.memory.bytes==b.memory.bytes,"Copy memory differs: count={count},delta={delta}");
   assert_eq!(format!("{:?}",a.cpu.regs),format!("{:?}",b.cpu.regs));assert_eq!(a.cpu.flags,b.cpu.flags);
  }}
 }
}
