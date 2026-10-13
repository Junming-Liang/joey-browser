//! Lossless specialization of the pinned original decoder's byte loop.
//! Prologue/allocation/zeroing and epilogue still execute original instructions.
use runtime::{Context, Cont, Flags};

fn overlaps(a: (usize, usize), b: (usize, usize)) -> bool { a.0 < b.1 && b.0 < a.1 }

pub fn try_decode(ctx: &mut Context) -> Option<Cont> {
    #[cfg(test)]
    if FORCE_SLOW.with(|flag| flag.get()) { return None; }
    let stack = ctx.cpu.regs.esp as usize;
    if ctx.cpu.flags.contains(Flags::DF) || stack < 0x1000 || stack.checked_add(40)? > ctx.memory.bytes.len() { return None; }
    let base = ctx.memory.read::<u32>((stack + 16) as u32) as usize;
    let output = ctx.memory.read::<u32>((stack + 28) as u32) as usize;
    let size = ctx.memory.read::<u32>((stack + 32) as u32) as usize;
    let source = ctx.cpu.regs.edx as usize;
    if ctx.cpu.regs.ebx as usize != base || ctx.cpu.regs.ebp as usize != output || ctx.cpu.regs.esi != 0xfee { return None; }
    let ring = (base.checked_add(4)?, base.checked_add(4117)?);
    let destination = (output, output.checked_add(size)?);
    let frame = (stack, stack + 40);
    if size == 0 || size > 64 << 20 || source < 0x1000 || output < 0x1000 || base < 0x1000 || ring.1 > ctx.memory.bytes.len() || destination.1 > ctx.memory.bytes.len() || overlaps(ring,destination) || overlaps(ring,frame) || overlaps(destination,frame) { return None; }
    // Scan token lengths before modifying anything. This gives the exact input
    // range, so overlapping or truncated input falls back to original code.
    let mut end = source; let mut left = size; let mut flags = 0u32;
    while left > 0 {
        flags >>= 1;
        if flags & 0x100 == 0 { flags = *ctx.memory.bytes.get(end)? as u32 | 0xff00; end += 1; }
        if flags & 1 != 0 { ctx.memory.bytes.get(end)?; end += 1; left -= 1; }
        else { ctx.memory.bytes.get(end)?; let high = *ctx.memory.bytes.get(end + 1)?; end += 2; left = left.saturating_sub((high as usize & 15) + 3); }
    }
    let input = (source,end);
    if overlaps(input,destination) || overlaps(input,ring) || overlaps(input,frame) { return None; }
    let mut source = source; let mut output = output; let mut left = size;
    let mut cursor = ctx.cpu.regs.esi as usize;
    if cursor >= 4096 { return None; }
    let mut flags = ctx.memory.read::<u32>((stack + 36) as u32);
    // Original entry has just initialized this flag word; indirect mid-loop
    // entries with other state use the unspecialized implementation.
    if flags != 0 { return None; }
    loop {
        flags >>= 1;
        if flags & 0x100 == 0 { flags = ctx.memory.bytes[source] as u32 | 0xff00; source += 1; }
        ctx.memory.write::<u32>((stack + 36) as u32,flags);
        if flags & 1 != 0 {
            let value = ctx.memory.bytes[source]; source += 1;
            ctx.memory.bytes[output] = value; output += 1; left -= 1;
            ctx.memory.write::<u32>((stack + 28) as u32,output as u32);
            ctx.memory.write::<u32>((stack + 32) as u32,left as u32);
            if left == 0 { break; }
            ctx.memory.bytes[ring.0 + cursor] = value; cursor = (cursor + 1) & 4095;
        } else {
            let low = ctx.memory.bytes[source] as usize;
            let high = ctx.memory.bytes[source + 1] as usize; source += 2;
            let offset = low | (high & 0xf0) << 4; let last = (high & 15) + 2;
            ctx.memory.write::<u32>((stack + 24) as u32,last as u32);
            for index in 0..=last {
                let value = ctx.memory.bytes[ring.0 + ((offset + index) & 4095)];
                ctx.memory.bytes[output] = value; output += 1; left -= 1;
                ctx.memory.write::<u32>((stack + 28) as u32,output as u32);
                ctx.memory.write::<u32>((stack + 32) as u32,left as u32);
                if left == 0 { break; }
                ctx.memory.bytes[ring.0 + cursor] = value; cursor = (cursor + 1) & 4095;
            }
            if left == 0 { break; }
        }
    }
    ctx.cpu.regs.edx = source as u32;
    Some(Cont(crate::generated::x54a11a))
}

#[cfg(test)]
thread_local! { pub static FORCE_SLOW: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
