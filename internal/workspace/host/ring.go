package host

// ring is a fixed-size byte ring addressed by absolute stream offset.
//
// The offset is the terminal protocol's `seq`: byte N of everything the program
// ever wrote is byte N here, whether or not it is still held. Keeping the address
// absolute is what lets a reconnecting front end say "I have everything below
// 4096" and have that mean the same thing before and after the ring wrapped.
//
// It is not safe for concurrent use; the terminal's mutex guards it.
type ring struct {
	buf  []byte
	size int
	// head is the total number of bytes ever written, i.e. the next seq.
	head int64
}

func newRing(size int) *ring {
	return &ring{buf: make([]byte, size), size: size}
}

// start is the lowest offset still held.
func (r *ring) start() int64 {
	if r.head > int64(r.size) {
		return r.head - int64(r.size)
	}
	return 0
}

// write appends p, overwriting the oldest bytes when full.
func (r *ring) write(p []byte) {
	if len(p) == 0 {
		return
	}
	if len(p) > r.size {
		// Only the last `size` bytes can survive. The skipped ones still count
		// toward head so later offsets stay true to the stream.
		skipped := len(p) - r.size
		r.head += int64(skipped)
		p = p[skipped:]
	}
	pos := int(r.head % int64(r.size))
	n := copy(r.buf[pos:], p)
	if n < len(p) {
		copy(r.buf, p[n:])
	}
	r.head += int64(len(p))
}

// read copies [from, to). The caller guarantees start() <= from <= to <= head.
func (r *ring) read(from, to int64) []byte {
	if to <= from {
		return nil
	}
	out := make([]byte, to-from)
	pos := int(from % int64(r.size))
	n := copy(out, r.buf[pos:])
	if n < len(out) {
		copy(out[n:], r.buf)
	}
	return out
}

// window answers a (re)attach: the bytes from `from` to the current head, the
// offset they really start at, and whether the request reached back past what is
// still held (a gap the front end has to be told about).
//
// An offset beyond head is clamped rather than refused: a front end that is
// ahead of us can only be confused about what it has, and "nothing new" is the
// most useful answer to that.
func (r *ring) window(from int64) (data []byte, actual int64, gap bool) {
	if from < 0 {
		from = 0
	}
	start := r.start()
	if from < start {
		from = start
		gap = true
	}
	if from > r.head {
		from = r.head
	}
	return r.read(from, r.head), from, gap
}
