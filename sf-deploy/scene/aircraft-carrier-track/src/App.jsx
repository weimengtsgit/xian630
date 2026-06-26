import { useState, useEffect } from 'react'
import MapView from './components/MapView'
import Timeline from './components/Timeline'
import EventCard from './components/EventCard'
import { trajectoryData } from './data/trajectoryData'
import './App.css'

function App() {
  const [selectedDay, setSelectedDay] = useState(1)
  const [showCard, setShowCard] = useState(false)
  const [carrierPosition, setCarrierPosition] = useState(trajectoryData[0].position)

  const handleDaySelect = (day) => {
    setSelectedDay(day)
    const data = trajectoryData.find(d => d.day === day)
    if (data) {
      setCarrierPosition(data.position)
    }
  }

  const handleCarrierClick = () => {
    setShowCard(!showCard)
  }

  const currentEvent = trajectoryData.find(d => d.day === selectedDay)

  return (
    <div className="app">
      <MapView
        carrierPosition={carrierPosition}
        onCarrierClick={handleCarrierClick}
      />
      <Timeline
        data={trajectoryData}
        selectedDay={selectedDay}
        onDaySelect={handleDaySelect}
      />
      {showCard && currentEvent && (
        <EventCard
          event={currentEvent}
          onClose={() => setShowCard(false)}
        />
      )}
    </div>
  )
}

export default App
