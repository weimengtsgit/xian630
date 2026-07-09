import { createApp } from './app.js'

const port = process.env.PORT || 80
createApp().listen(port, () => console.log(`agent-pipeline server on :${port}`))
