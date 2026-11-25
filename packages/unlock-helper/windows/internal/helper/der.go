package helper

import "math/big"

func pad32(n *big.Int) []byte {
	b := n.Bytes()
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

// P1363ToDER turns a raw r||s ECDSA signature (64 bytes, what Windows CNG returns) into ASN.1 DER, the format the
// macOS helper returns and hap-core's ecdsaDerToRaw accepts.
func P1363ToDER(rs []byte) ([]byte, error) {
	if len(rs) != 64 {
		return nil, Err("internal", "Signature has the wrong length.")
	}
	enc := func(b []byte) []byte {
		v := new(big.Int).SetBytes(b).Bytes()
		if len(v) == 0 {
			v = []byte{0}
		}
		if v[0]&0x80 != 0 {
			v = append([]byte{0}, v...)
		}
		return append([]byte{0x02, byte(len(v))}, v...)
	}
	r, s := enc(rs[:32]), enc(rs[32:])
	body := append(r, s...)
	return append([]byte{0x30, byte(len(body))}, body...), nil
}
