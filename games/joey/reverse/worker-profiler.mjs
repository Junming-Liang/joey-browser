// Diagnostic only: sample the actual original-game worker, not the page host.
export async function startWorkerProfiler(browser, workerURL) {
  const cdp = await browser.newBrowserCDPSession();
  const pending = new Map();
  let nextId = 0, sessionId;
  const close = async () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(Error('Worker profiler closed'));
    }
    pending.clear();
    await cdp.detach();
  };
  try {
    const {targetInfos} = await cdp.send('Target.getTargets');
    const targets = targetInfos.filter(target => target.type === 'worker' && target.url === workerURL);
    if (targets.length !== 1) throw Error('Expected one original main worker, found ' + targets.length);
    ({sessionId} = await cdp.send('Target.attachToTarget', {targetId: targets[0].targetId, flatten: false}));
    cdp.on('Target.receivedMessageFromTarget', event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message), request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timeout);
      message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => { pending.delete(id); reject(Error('Worker profiler timeout: ' + method)); }, 15000);
      pending.set(id, {resolve, reject, timeout});
      cdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})}).catch(error => {
        pending.delete(id); clearTimeout(timeout); reject(error);
      });
    });
    const clock = () => ({epochMs: Date.now(), monotonicUs: Number(process.hrtime.bigint() / 1000n)});
    await command('Profiler.enable');
    await command('Profiler.setSamplingInterval', {interval: 1000});
    const beforeStart = clock(); await command('Profiler.start'); const afterStart = clock();
    return {
      close,
      async stop() {
        try {
          const beforeStop = clock();
          const {profile} = await command('Profiler.stop');
          const afterStop = clock();
          // Only align to page Date.now if the clocks agree in this actual run.
          const sameClock = profile.startTime >= beforeStart.monotonicUs && profile.startTime <= afterStart.monotonicUs &&
            profile.endTime >= beforeStop.monotonicUs && profile.endTime <= afterStop.monotonicUs;
          return {profile, clock: {beforeStart, afterStart, beforeStop, afterStop, sameMonotonicClock: sameClock,
            limitation: '1ms sampling with profiler overhead; frame gaps include original sleeps and host scheduling, not pure CPU time'}};
        } finally { await close(); }
      }
    };
  } catch (error) { await close(); throw error; }
}
