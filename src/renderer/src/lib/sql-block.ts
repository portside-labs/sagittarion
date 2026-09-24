/**
 * The block of text around an offset: the contiguous non-blank lines it sits in. Blank lines separate
 * blocks, so a script of several statements runs one block at a time. On a blank line the block above
 * is taken, or the one below when there is none above. Empty when the text has no block at all.
 */
export function blockAt(text: string, offset: number): string {
  const lines = text.split('\n')
  const blank = (i: number) => lines[i].trim() === ''
  // Which line the offset falls on.
  let pos = 0
  let cur = 0
  for (let i = 0; i < lines.length; i++) {
    const end = pos + lines[i].length
    if (offset <= end || i === lines.length - 1) {
      cur = i
      break
    }
    pos = end + 1
  }
  if (blank(cur)) {
    let up = cur
    while (up > 0 && blank(up)) up--
    if (!blank(up)) cur = up
    else {
      let down = cur
      while (down < lines.length - 1 && blank(down)) down++
      if (blank(down)) return ''
      cur = down
    }
  }
  let start = cur
  let end = cur
  while (start > 0 && !blank(start - 1)) start--
  while (end < lines.length - 1 && !blank(end + 1)) end++
  return lines.slice(start, end + 1).join('\n')
}
