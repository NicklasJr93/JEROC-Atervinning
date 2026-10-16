import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelematicsStore } from '../server/telematics/storage.mjs';
import { createTelematicsReceiver } from '../server/telematics/receiver.mjs';
import { projectTrips } from '../server/telematics/trips.mjs';
import { connectSimulatedTracker, simulatedImeiHandshake, simulatedFtc134Frame } from '../server/telematics/simulator.mjs';

// All identities are fictional and resolved by this isolated demo registry.
// No production app, tracker, credentials, device or outside server is used.
const directory = await mkdtemp(join(tmpdir(), 'scrappilot-telematics-demo-'));
let store, receiver, client;
try {
  store = await createTelematicsStore({ filename: join(directory, 'pilot.sqlite'),
    resolveVehicle: async reference => reference.tenantId === 'demo-company' && reference.vehicleId === 'demo-vehicle'
      ? { ...reference, active: true, defaultDriver: { id: 'demo-default-driver', tenantId: 'demo-company', active: true } } : null });
  const device = await store.registerDevice({ imei: '356307042441013', tenantId: 'demo-company', vehicleId: 'demo-vehicle' });
  receiver = await createTelematicsReceiver({ store });
  const tracker = await connectSimulatedTracker(receiver.address.port); client = tracker.socket;
  let reply = tracker.readBytes(1); client.write(simulatedImeiHandshake(device.imei));
  if (!(await reply).equals(Buffer.from([1]))) throw new Error('Demo handshake failed');
  const frame = simulatedFtc134Frame([
    { at: '2026-10-16T07:00:00.000Z', ignition: false, odometerMeters: 100000 },
    { at: '2026-10-16T07:01:00.000Z', ignition: true, movement: true, odometerMeters: 100000 },
    { at: '2026-10-16T07:15:00.000Z', ignition: false, movement: false, odometerMeters: 106500 },
  ]);
  // Deliberately fragmented to exercise a real TCP stream, then retransmitted.
  reply = tracker.readBytes(4); client.write(frame.subarray(0, 9)); client.write(frame.subarray(9));
  if ((await reply).readUInt32BE() !== 3) throw new Error('Demo commit ACK failed');
  reply = tracker.readBytes(4); client.write(frame);
  if ((await reply).readUInt32BE() !== 3) throw new Error('Demo retry ACK failed');
  const page = await store.listRecords({ tenantId: device.tenantId, deviceId: device.id });
  const trips = projectTrips(page.records);
  console.log(JSON.stringify({ mode: 'local-simulator', acceptedIncludingRetry: 6, storedRecords: page.records.length,
    trips, coordinatesStored: false, productionConnected: false }, null, 2));
} finally {
  client?.destroy(); await receiver?.close(); store?.close();
  await rm(directory, { recursive: true, force: true });
}
