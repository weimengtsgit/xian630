export function revealAircraftSelection(icao) {
  return {
    selectedIcao: icao,
    selectedCarrierId: null,
    carrierFilter: "ALL",
  };
}
