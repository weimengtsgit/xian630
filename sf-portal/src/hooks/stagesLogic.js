export function allCompleted(stages) {
  return Array.isArray(stages) && stages.length > 0 && stages.every(s => s && s.status === 'completed')
}
