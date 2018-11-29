// @flow
/**
 * Compute an isoline as a GeoJSON feature from a regular grid
 * Uses the Marching Squares algorithm, with code ported from
 * https://github.com/conveyal/r5/blob/master/src/main/java/com/conveyal/r5/analyst/IsochroneFeature.java
 * @author mattwigway
 */

import {point} from '@turf/helpers'
import inside from '@turf/boolean-point-in-polygon'

type Coordinate = [number, number]

const MAX_COORDS = 20000

// Previously we used `debug`
const logError = e => console.error(e)

/**
 * Create a JSON isoline. Surface is a (possibly typed) array, width and height
 * are its width and height, and cutoff is the cutoff. It is possible to disable
 * linear interpolation for testing purposes by passing interpolation: false.
 */
export default function jsolines ({
  cutoff,
  height,
  maxCoordinates = MAX_COORDS,
  project,
  interpolation = true,
  surface,
  width
}: {
  cutoff: number,
  height: number,
  interpolation: boolean,
  maxCoordinates: number,
  project: (Coordinate) => Coordinate,
  surface: Uint8Array,
  width: number
}) {
  // First, create the contour grid.
  const contour = getContour({surface, width, height, cutoff})
  const cWidth = width - 1

  // JavaScript does not have boolean arrays. lame.
  const found = new Uint8Array((width - 1) * (height - 1))

  // DEBUG, comment out to save memory
  const indices = []

  // We'll sort out what shell goes with what hole in a bit.
  const shells = []
  const holes = []

  // Find a cell that has a line in it, then follow that line, keeping filled
  // area to your left. This lets us use winding direction to determine holes.
  for (let origy = 0; origy < height - 1; origy++) {
    for (let origx = 0; origx < width - 1; origx++) {
      if (found[origy * cWidth + origx] === 1) {
        continue
      }

      let idx = contour[origy * cWidth + origx]
      // Continue if there is no line here or if it's a saddle, as we don't know which way the saddle goes.
      if (idx === 0 || idx === 5 || idx === 10 || idx === 15) continue

      // Huzzah! We have found a line, now follow it, keeping the filled area to our left,
      // which allows us to use the winding direction to determine what should be a shell and
      // what should be a hole
      let x = origx
      let y = origy

      let prevx = -1
      let prevy = -1
      let startx = -1
      let starty = -1

      // Track winding direction
      let direction = 0

      const coords = []

      while (true) {
        // Make sure we're not traveling in circles.
        // NB using index from _previous_ cell, we have not yet set an index for this cell
        if (found[y * cWidth + x] === 1) {
          logError(`Ring crosses other ring (or possibly self) at ${x}, ${y} coming from case ${idx}`)
          logError(`Last few indices: ${indices.slice(Math.max(0, indices.length - 10)).join(',')}`)
          break
        }

        prevx = startx
        prevy = starty
        startx = x
        starty = y
        idx = contour[y * cWidth + x]

        indices.push(idx)

        // Mark as found if it's not a saddle because we expect to reach saddles twice.
        if (idx !== 5 && idx !== 10) {
          found[y * cWidth + x] = 1
        }

        if (idx === 0 || idx === 15) {
          logError('Ran off outside of ring')
          break
        }

        // Follow the loop
        [x, y] = followLoop({idx, prevx, prevy, x, y})

        // Keep track of winding direction
        direction += (x - startx) * (y + starty)

        // Shift exact coordinates
        const coord = interpolation
          ? interpolate({x, y, cutoff, startx, starty, surface, width, height})
          : noInterpolate({x, y, startx, starty})

        if (!coord) {
          logError(`Unexpected coordinate shift from ${startx}, ${starty} to ${x}, ${y}, discarding ring`)
          break
        }

        coords.push(project(coord))

        // TODO Remove completely? May be unnecessary.
        if (coords.length > maxCoordinates) {
          logError(`Ring coordinates > ${maxCoordinates} found, skipping`)
          break
        }

        // We're back at the start of the ring
        if (x === origx && y === origy) {
          coords.push(coords[0]) // close the ring

          // make it a fully-fledged GeoJSON object
          const geom = {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [coords]
            }
          }

          // Check winding direction. Positive here means counter clockwise,
          // see http://stackoverflow.com/questions/1165647
          // +y is down so the signs are reversed from what would be expected
          if (direction > 0) shells.push(geom)
          else holes.push(geom)
          break
        }
      }
    }
  }

  // Shell game time. Sort out shells and holes.
  holes.forEach((hole) => {
    // NB this is checking whether the first coordinate of the hole is inside
    // the shell. This is sufficient as shells don't overlap, and holes are
    // guaranteed to be completely contained by a single shell.
    const holePoint = point(hole.geometry.coordinates[0][0])
    const containingShell = shells.find((shell) => inside(holePoint, shell))

    if (containingShell) {
      containingShell.geometry.coordinates.push(hole.geometry.coordinates[0])
    } else {
      logError('Did not find fitting shell for hole')
    }
  })

  return {
    type: 'Feature',
    geometry: {
      type: 'MultiPolygon',
      coordinates: shells.map(s => s.geometry.coordinates)
    }
  }
}

/**
 * Follow the loop
 * We keep track of which contour cell we're in, and we always keep the filled
 * area to our left. Thus we always indicate only which direction we exit the
 * cell.
 */
function followLoop ({idx, prevx, prevy, x, y}) {
  switch (idx) {
    case 1: return [x - 1, y]
    // NB: +y is down
    case 2: return [x, y + 1]
    case 3: return [x - 1, y]
    case 4: return [x + 1, y]
    case 5:
      // Assume that saddle has // orientation (as opposed to \\). It doesn't
      // really matter if we're wrong, we'll just have two disjoint pieces
      // where we should have one, or vice versa.

      // From bottom
      if (prevy > y) return [x + 1, y]

      // From top
      if (prevy < y) return [x - 1, y]

      logError('Entered case 5 saddle point from wrong direction!')
      return [x, y]
    case 6: return [x, y + 1]
    case 7: return [x - 1, y]
    case 8: return [x, y - 1]
    case 9: return [x, y - 1]
    case 10: // hex a
      // From left
      if (prevx < x) return [x, y + 1]

      // From right
      if (prevx > x) return [x, y - 1]

      logError('Entered case 10 saddle point from wrong direction.')
      return [x, y]
    case 11: return [x, y - 1] // b
    case 12: return [x + 1, y] // c
    case 13: return [x + 1, y] // d
    case 14: return [x, y + 1] // e
  }
}

// Calculated fractions may not be numbers causing interpolation to fail.
const ensureFractionIsNumber = (frac, direction) => {
  if (isNaN(frac) || frac === Infinity) {
    logError(`Segment fraction from ${direction} is ${frac}; if this is at the edge of the query this is expected.`)
    return 0.5
  }
  return frac
}

/**
 * Do linear interpolation.
 */
function interpolate ({
  cutoff,
  height,
  startx,
  starty,
  surface,
  width,
  x,
  y
}: {
  cutoff: number,
  height: number,
  startx: number,
  starty: number,
  surface: Uint8Array,
  width: number,
  x: number,
  y: number
}): (Coordinate | void) {
  const index = y * width + x
  let topLeft = surface[index]
  let topRight = surface[index + 1]
  let botLeft = surface[index + width]
  let botRight = surface[index + width + 1]

  // The edges are always considered unreachable to avoid edge effects so set
  // them to the cutoff.
  if (x === 0) topLeft = botLeft = cutoff
  if (y === 0) topLeft = topRight = cutoff
  if (y === height - 2) botRight = botLeft = cutoff
  if (x === width - 2) topRight = botRight = cutoff

  // From left
  if (startx < x) {
    const frac = (cutoff - topLeft) / (botLeft - topLeft)
    return [x, y + ensureFractionIsNumber(frac, 'left')]
  }

  // From right
  if (startx > x) {
    const frac = (cutoff - topRight) / (botRight - topRight)
    return [x + 1, y + ensureFractionIsNumber(frac, 'right')]
  }

  // From bottom
  if (starty > y) {
    const frac = (cutoff - botLeft) / (botRight - botLeft)
    return [x + ensureFractionIsNumber(frac, 'bottom'), y + 1]
  }

  // From top
  if (starty < y) {
    const frac = (cutoff - topLeft) / (topRight - topLeft)
    return [x + ensureFractionIsNumber(frac, 'top'), y]
  }
}

/**
 * Used for testing.
 */
function noInterpolate ({startx, starty, x, y}: {
  startx: number,
  starty: number,
  x: number,
  y: number
}): (Coordinate | void) {
  // From left
  if (startx < x) return [x, y + 0.5]
  // From right
  if (startx > x) return [x + 1, y + 0.5]
  // From bottom
  if (starty > y) return [x + 0.5, y + 1]
  // From top
  if (starty < y) return [x + 0.5, y]
}

/**
 * Get a contouring grid. Exported for testing purposes, not generally used
 * outside jsolines testing
 */
export function getContour ({
  surface,
  width,
  height,
  cutoff
}: {
  cutoff: number,
  height: number,
  surface: Uint8Array,
  width: number
}): Uint8Array {
  const contour = new Uint8Array((width - 1) * (height - 1))

  // compute contour values for each cell
  for (let x = 0; x < width - 1; x++) {
    for (let y = 0; y < height - 1; y++) {
      const index = y * width + x
      let topLeft = surface[index] < cutoff
      let topRight = surface[index + 1] < cutoff
      let botLeft = surface[index + width] < cutoff
      let botRight = surface[index + width + 1] < cutoff

      // if we're at the edge of the area, set the outer sides to false, so that
      // isochrones always close even when they actually extend beyond the edges
      // of the surface
      if (x === 0) topLeft = botLeft = false
      if (x === width - 2) topRight = botRight = false
      if (y === 0) topLeft = topRight = false
      if (y === height - 2) botRight = botLeft = false

      let idx = 0

      if (topLeft) idx |= 1 << 3
      if (topRight) idx |= 1 << 2
      if (botRight) idx |= 1 << 1
      if (botLeft) idx |= 1

      contour[y * (width - 1) + x] = idx
    }
  }

  return contour
}
