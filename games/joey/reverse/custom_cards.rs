//! Five additive cards for the pinned Joey executable. Original IDs keep their original paths.
use runtime::{Context, Cont, Flags};

pub const FIRST: u16 = 1115;
pub const COUNT: u32 = 5;
pub const TEA: u16 = FIRST;
pub const RICE: u16 = FIRST + 1;
pub const CACTUS: u16 = FIRST + 4;
const COLLECTION: u32 = 0xa53ccc;
// Two unused padding bytes after the original 1115-word stack snapshot.
const SEEN_PADDING: u32 = 0x8d6;

// The game executes its duel logic on one guest thread. Keep the latch outside
// guest RAM and key it by memory identity so independent native fixtures cannot
// inherit another game's outcome. A new duel always clears it at 0x5b9f50.
#[derive(Clone, Copy, Default)]
struct DuelLatch { memory: usize, winner: Option<u32>, flip_was_set: bool }
std::thread_local! { static DUEL: std::cell::Cell<DuelLatch> = const { std::cell::Cell::new(DuelLatch { memory: 0, winner: None, flip_was_set: false }) }; }

fn latch(ctx: &Context) -> DuelLatch {
    let memory = ctx.memory.bytes.as_ptr() as usize;
    let saved = DUEL.with(|cell| cell.get());
    if saved.memory == memory { saved } else { DuelLatch { memory, ..Default::default() } }
}

pub fn reset_duel(ctx: &Context) {
    DUEL.with(|cell| cell.set(DuelLatch { memory: ctx.memory.bytes.as_ptr() as usize, ..Default::default() }));
}

fn register_victory(ctx: &Context, internal: u16, side: u32) {
    if ctx.memory.read::<u32>(0x5f3294) == 3 || ctx.memory.read::<u8>(0xa577fa) & 0x20 != 0 {
        return;
    }
    let mut saved = latch(ctx);
    if saved.winner.is_none() && ctx.memory.read::<u8>(0xa577f4) & 0x10 == 0 {
        // Only the guest worker waits for this bounded presentation RPC. The
        // browser page continues drawing the thematic card performance.
        host::host().collectible_event(u32::from(internal), side & 1);
        saved.winner = Some(side & 1);
        DUEL.with(|cell| cell.set(saved));
    }
}

pub fn resolved_tea(ctx: &Context) {
    // 0x584d00 has already rejected the original effect-negated bit 0x4.
    // The argument remains after the saved ESI/EDI and return address.
    let effect = ctx.memory.read::<u32>(ctx.cpu.regs.esp + 12);
    register_victory(ctx, TEA, u32::from(ctx.memory.read::<u16>(effect + 2) & 1));
}

pub fn begin_flip(ctx: &Context) {
    let task = ctx.memory.read::<u32>(0xa55080);
    let side = task & 1;
    let slot = (task >> 1) & 31;
    let mut saved = latch(ctx);
    saved.flip_was_set = slot < 5 && ctx.memory.read::<u8>(0xa55d7a + side * 0xd44 + slot * 0x90) & 2 == 0;
    DUEL.with(|cell| cell.set(saved));
}

pub fn resolved_summon(ctx: &Context) {
    // This boundary is after the original summon/negation state machine and
    // before its successful-entry notification. Kind 3 also handles ordinary
    // position changes, so require the face-down snapshot from its first stage.
    let kind = (ctx.memory.read::<u16>(0xa5508e) >> 2) & 7;
    let task = ctx.memory.read::<u32>(0xa55080);
    let side = task & 1;
    let slot = (task >> 1) & 31;
    if !(1..=6).contains(&kind) || slot >= 5 || (kind == 3 && !latch(ctx).flip_was_set) { return; }
    let field = 0xa55d74 + side * 0xd44 + slot * 0x90;
    let internal = ctx.memory.read::<u16>(field) & 0xfff;
    if (FIRST + 1..FIRST + COUNT as u16).contains(&internal) && ctx.memory.read::<u8>(field + 6) & 2 != 0 {
        register_victory(ctx, internal, side);
    }
}

pub fn resolve_victory(ctx: &mut Context) -> bool {
    if ctx.memory.read::<u32>(0x5f3294) == 3 || ctx.memory.read::<u8>(0xa577fa) & 0x20 != 0 { return false; }
    let Some(winner) = latch(ctx).winner else { return false; };
    let local = ctx.memory.read::<u32>(0xa54e5c) & 1;
    // These are the common formal result flags written by original Exodia,
    // Destiny Board and LP victory branches at 0x5bc050. LP and special-win
    // animation flags remain untouched; original result/reward handling follows.
    let state = ctx.memory.read::<u16>(0xa577fa);
    ctx.memory.write::<u16>(0xa577fa, (state & !0xc0) | if winner == local { 0x40 } else { 0x80 });
    let ended = ctx.memory.read::<u8>(0xa577f4);
    ctx.memory.write::<u8>(0xa577f4, ended | 0x10);
    true
}

pub fn reject_network_deck(ctx: &mut Context) -> bool {
    if ctx.memory.read::<u32>(0x5f3294) != 3 { return false; }
    for (base, count_addr, limit) in [(0xa54e60, 0xa54f3c, 80), (0xa54f1e, 0xa54f40, 15)] {
        let count = u32::from(ctx.memory.read::<u16>(count_addr));
        let forbidden = count > limit || (0..count).any(|i| {
            let id = ctx.memory.read::<u16>(base + i * 2);
            (FIRST..FIRST + COUNT as u16).contains(&id)
        });
        if forbidden {
            // Original network-abort flag, deliberately without win/loss bits.
            let state = ctx.memory.read::<u16>(0xa577fa);
            ctx.memory.write::<u16>(0xa577fa, state | 0x20);
            return true;
        }
    }
    false
}

pub fn reward_statistics(ctx: &mut Context) {
    let owned = (0..COUNT)
        .filter(|i| ctx.memory.read::<u8>(COLLECTION + (u32::from(FIRST) + i) * 2) != 0)
        .count() as u32;
    ctx.memory.write::<u32>(ctx.cpu.regs.esp + 0x24, owned);
    ctx.memory.write::<u32>(ctx.cpu.regs.esp + 0x1c, COUNT);
}

pub fn reward_choice(ctx: &mut Context) -> Cont {
    // EDX is the existing original RNG remainder after division by five.
    assert!(ctx.cpu.regs.edx < COUNT);
    ctx.cpu.regs.esi = u32::from(FIRST) + ctx.cpu.regs.edx;
    Cont(crate::generated::x44570d)
}

pub fn save_seen(ctx: &mut Context) {
    let mut seen = 0u16;
    for i in 0..COUNT {
        seen |= ((ctx.memory.read::<u16>(COLLECTION + (u32::from(FIRST) + i) * 2) >> 14) & 1) << i;
    }
    ctx.memory.write::<u16>(ctx.cpu.regs.esp + SEEN_PADDING, seen);
}

pub fn restore_seen(ctx: &mut Context) {
    let seen = ctx.memory.read::<u16>(ctx.cpu.regs.esp + SEEN_PADDING);
    for i in 0..COUNT {
        if seen & (1 << i) != 0 {
            let addr = COLLECTION + (u32::from(FIRST) + i) * 2;
            let value = ctx.memory.read::<u16>(addr);
            ctx.memory.write::<u16>(addr, value | 0x4000);
        }
    }
}

pub fn ai_tea_fallback(ctx: &mut Context) -> bool {
    // The original scan has failed but has not restored its stack/register frame.
    // Only Dian Keto's real priority rows gain a second attempt; success never reaches here.
    let stack = ctx.cpu.regs.esp;
    let row = ctx.memory.read::<u32>(stack + 0x34);
    if ctx.memory.read::<u32>(row) != 341 || ctx.memory.read::<u32>(row + 4) != 0x5b48d0 {
        return false;
    }
    // The original scan reuses its player argument stack slot for the slot counter.
    let player = ctx.cpu.regs.ebx;
    let r = &ctx.cpu.regs;
    let saved = [r.eax, r.ecx, r.edx, r.ebx, r.esi, r.edi, r.esp, r.ebp];
    let flags = ctx.cpu.flags.bits();
    ctx.push32(0x5b48d0);
    ctx.push32(1950);
    let tea_row = ctx.cpu.regs.esp;
    ctx.push32(tea_row);
    ctx.push32(player);
    let target_esp = ctx.cpu.regs.esp;
    ctx.push32(runtime::RETURN_FROM_X86_ADDR32);
    ctx.cpu_loop(Cont(crate::generated::x5b5e00), target_esp);
    let result = ctx.cpu.regs.eax;
    let r = &mut ctx.cpu.regs;
    [r.eax, r.ecx, r.edx, r.ebx, r.esi, r.edi, r.esp, r.ebp] = saved;
    ctx.cpu.flags = Flags::from_bits_retain(flags);
    result != 0
}
