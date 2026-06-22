import assert from 'node:assert/strict'
import {
  CHAT_TEXTAREA_MAX_HEIGHT,
  CHAT_TEXTAREA_MIN_HEIGHT,
  textareaSizingForScrollHeight,
} from '../src/components/chatTextareaAutosize.js'

assert.deepEqual(textareaSizingForScrollHeight(0), {
  height: `${CHAT_TEXTAREA_MIN_HEIGHT}px`,
  overflowY: 'hidden',
})

assert.deepEqual(textareaSizingForScrollHeight(CHAT_TEXTAREA_MIN_HEIGHT + 24), {
  height: `${CHAT_TEXTAREA_MIN_HEIGHT + 24}px`,
  overflowY: 'hidden',
})

assert.deepEqual(textareaSizingForScrollHeight(CHAT_TEXTAREA_MAX_HEIGHT + 80), {
  height: `${CHAT_TEXTAREA_MAX_HEIGHT}px`,
  overflowY: 'auto',
})

console.log('check-chat-input-sizing: OK')
