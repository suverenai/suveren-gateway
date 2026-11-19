import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { deviceClient } from './device-client';
import { endIsDeviceSigned } from './end-mandate';

/**
 * True only on a gateway with the device-keys switch on, a password session and a set-up device (a chain account).
 * Everything else, including flag off and no chain, is false: the page stays exactly as it was.
 */
export function useDeviceChain(): boolean {
  const { deviceKeysSwitch, access } = useAuth();
  const [chain, setChain] = useState(false);
  useEffect(() => {
    if (!deviceKeysSwitch || access !== 'password') { setChain(false); return; }
    let live = true;
    void deviceClient.status().then(r => { if (live) setChain(r.ok && endIsDeviceSigned({ deviceKeysSwitch, access }, r.data)); });
    return () => { live = false; };
  }, [deviceKeysSwitch, access]);
  return chain;
}
