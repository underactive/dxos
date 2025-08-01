interface WindowState {
  id: string
  title: string
  route: string
  x: number
  y: number
  width: number
  height: number
  isMinimized: boolean
  isMaximized: boolean
  zIndex: number
  isVisible: boolean
  isAnimating?: boolean
  animationProgress?: number
  // System 7 animation properties
  animationOutlines?: Array<{
    x: number
    y: number
    width: number
    height: number
    opacity: number
  }>
  originalPosition?: { x: number, y: number, width: number, height: number }
  dockPosition?: { x: number, y: number }
  // Fixed size and resizing properties
  isResizable?: boolean
  fixedWidth?: number
  fixedHeight?: number
}

interface WindowOptions {
  x?: number
  y?: number
  width?: number
  height?: number
  isResizable?: boolean
  fixedWidth?: number
  fixedHeight?: number
}

export const useWindowManager = () => {
  // Use useState to create global state that's shared across components
  const windows = useState<WindowState[]>('dxos-windows', () => [])
  const nextZIndex = useState<number>('dxos-next-z-index', () => 1000)
  const dockPosition = useState<{ x: number, y: number }>('dxos-dock-position', () => ({ x: 0, y: 0 }))
  
  // Move composable calls to top level to avoid lifecycle warnings
  const { settings } = useSettings()
  const { isDockVisible } = useDockAutoHide()
  
  // Utility functions for window positioning calculations
  const getViewportBounds = (windowWidth: number, windowHeight: number) => {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    
    // Get actual menu bar and dock positions
    const menuBar = document.querySelector('.menu-bar')
    const dockContainer = document.querySelector('.dock-container')
    
    let minY = 0
    let maxY = viewportHeight - windowHeight
    let maxHeight = viewportHeight - 40
    
    // Calculate Y bounds based on menu bar
    if (menuBar) {
      const menuBarRect = menuBar.getBoundingClientRect()
      minY = menuBarRect.bottom + 8 // Start below the menu bar with 8px spacing
      maxHeight = viewportHeight - menuBarRect.bottom - 8 - 40 // Account for 8px spacing
    }
    
    // Calculate Y bounds based on dock
    if (dockContainer) {
      const dockRect = dockContainer.getBoundingClientRect()
      // Check if dock is auto-hidden
      if (!settings.value.autoHideDock || isDockVisible.value) {
        maxY = dockRect.top - windowHeight // Stop above the dock
        maxHeight = Math.min(maxHeight, dockRect.top - 40)
      } else {
        // If dock is auto-hidden, allow windows to go to bottom of screen
        maxY = viewportHeight - windowHeight
      }
    }
    
    return {
      minX: 0,
      maxX: viewportWidth - windowWidth,
      minY,
      maxY,
      maxWidth: viewportWidth,
      maxHeight,
      viewportWidth,
      viewportHeight
    }
  }
  
  // Z-index management constants
  const MAX_Z_INDEX = 9999 // Maximum z-index before reset
  const BASE_Z_INDEX = 1000 // Starting z-index
  
  // Normalize z-indexes when they get too high
  const normalizeZIndexes = (): void => {
    if (nextZIndex.value >= MAX_Z_INDEX) {
      // Sort windows by current z-index
      const sortedWindows = [...windows.value].sort((a, b) => a.zIndex - b.zIndex)
      
      // Reassign z-indexes starting from BASE_Z_INDEX
      sortedWindows.forEach((window, index) => {
        const windowIndex = windows.value.findIndex(w => w.id === window.id)
        if (windowIndex !== -1) {
          windows.value[windowIndex] = {
            ...windows.value[windowIndex],
            zIndex: BASE_Z_INDEX + index
          }
        }
      })
      
      // Reset nextZIndex to continue from the highest assigned value
      nextZIndex.value = BASE_Z_INDEX + windows.value.length
    }
  }
  
  // Get next z-index with automatic normalization
  const getNextZIndex = (): number => {
    normalizeZIndexes()
    return nextZIndex.value++
  }

  // Initialize windows from localStorage if available
  onMounted(() => {
    // Clear localStorage for now to start fresh
    localStorage.removeItem('dxos-windows')
    
    // For now, don't load saved windows to avoid showing all windows at once
    // const savedWindows = localStorage.getItem('dxos-windows')
    // if (savedWindows) {
    //   try {
    //     windows.value = JSON.parse(savedWindows)
    //     // Update z-index to ensure proper layering
    //     nextZIndex.value = Math.max(...windows.value.map(w => w.zIndex), 1000) + 1
    //   } catch (e) {
    //     console.error('Failed to load saved windows:', e)
    //   }
    // }
    
    // Add window resize listener to ensure windows stay within bounds
    const handleResize = () => {
      ensureWindowsInBounds()
    }
    
    window.addEventListener('resize', handleResize)
    
    // Cleanup on unmount
    onUnmounted(() => {
      window.removeEventListener('resize', handleResize)
    })
  })

  // Debounce function for localStorage saving
  let saveTimeout: NodeJS.Timeout | null = null
  let lastSavedState: string = ''
  
  // Save windows to localStorage whenever they change (debounced)
  watch(windows, (newWindows) => {
    // Clear existing timeout
    if (saveTimeout) {
      clearTimeout(saveTimeout)
    }
    
    // Debounce the save to avoid excessive localStorage writes
    saveTimeout = setTimeout(() => {
      const newState = JSON.stringify(newWindows)
      // Only save if the state actually changed
      if (newState !== lastSavedState) {
        localStorage.setItem('dxos-windows', newState)
        lastSavedState = newState
      }
    }, 100) // Save after 100ms of no changes
  }, { deep: false }) // Don't use deep watching for better performance

    // Calculate responsive window position that ensures the window is fully visible
  const calculateResponsivePosition = (
    desiredX: number | undefined, 
    desiredY: number | undefined, 
    width: number, 
    height: number,
    windowIndex: number = 0
  ): { x: number, y: number } => {
    const bounds = getViewportBounds(width, height)
    
    // Start with desired position or use cascading offset
    let x: number
    let y: number
    
    // If no specific position provided, use cascading offset
    if (desiredX === undefined || desiredY === undefined) {
      const cascadeOffset = 30
      x = 20 + (windowIndex * cascadeOffset) // Small offset for cascading, but no margin constraint
      y = bounds.minY + (windowIndex * cascadeOffset)
    } else {
      x = desiredX
      y = desiredY
    }
    
    // Ensure window is within bounds
    x = Math.max(bounds.minX, Math.min(bounds.maxX, x))
    y = Math.max(bounds.minY, Math.min(bounds.maxY, y))
    
    return { x, y }
  }

  // Calculate responsive window size based on screen size
  const calculateResponsiveSize = (desiredWidth: number | undefined, desiredHeight: number | undefined): { width: number, height: number } => {
    // Use estimated size for bounds calculation, will be refined below
    const estimatedSize = getViewportBounds(800, 600)
    
    // Default sizes for different screen sizes
    let width: number
    let height: number
    
    // If no specific size provided, use responsive defaults
    if (desiredWidth === undefined || desiredHeight === undefined) {
      if (estimatedSize.viewportWidth < 768) {
        // Mobile/tablet
        width = estimatedSize.viewportWidth
        height = Math.min(600, estimatedSize.maxHeight)
      } else if (estimatedSize.viewportWidth < 1024) {
        // Small laptop
        width = Math.min(700, estimatedSize.viewportWidth)
        height = Math.min(500, estimatedSize.maxHeight)
      } else {
        // Desktop
        width = 800
        height = Math.min(600, estimatedSize.maxHeight)
      }
    } else {
      width = desiredWidth
      height = desiredHeight
    }
    
    // Get accurate bounds with final dimensions
    const finalBounds = getViewportBounds(width, height)
    
    // Ensure window size is within bounds
    width = Math.min(finalBounds.maxWidth, Math.max(300, width))
    height = Math.min(finalBounds.maxHeight, Math.max(200, height))
    
    return { width, height }
  }

  // Smooth resize updates
  const smoothUpdateSize = (windowId: string, width: number, height: number) => {
    // Update immediately for responsive feel
    updateWindowSize(windowId, width, height)
  }

  const openWindow = (route: string, title: string, options: WindowOptions = {}): string => {
    const existingWindow = windows.value.find(w => w.route === route)
    
    if (existingWindow) {
      // If window exists, bring it to front and make it visible
      const index = windows.value.findIndex(w => w.id === existingWindow.id)
      if (index !== -1) {
        // Determine new size if options are provided
        let newWidth = existingWindow.width
        let newHeight = existingWindow.height
        
        if (options.fixedWidth !== undefined && options.fixedHeight !== undefined) {
          // Use fixed dimensions when specified
          newWidth = options.fixedWidth
          newHeight = options.fixedHeight
        } else if (options.width !== undefined && options.height !== undefined) {
          // Use provided dimensions
          newWidth = options.width
          newHeight = options.height
        }
        
        windows.value[index] = {
          ...windows.value[index],
          isVisible: true,
          isMinimized: false,
          zIndex: getNextZIndex(),
          width: newWidth,
          height: newHeight,
          // Update resizing properties if provided
          isResizable: options.isResizable !== undefined ? options.isResizable : windows.value[index].isResizable,
          fixedWidth: options.fixedWidth !== undefined ? options.fixedWidth : windows.value[index].fixedWidth,
          fixedHeight: options.fixedHeight !== undefined ? options.fixedHeight : windows.value[index].fixedHeight
        }
      }
      return existingWindow.id
    }

    // Determine final width and height based on fixed size options
    let finalWidth: number
    let finalHeight: number
    
    if (options.fixedWidth !== undefined && options.fixedHeight !== undefined) {
      // Use fixed dimensions when specified
      finalWidth = options.fixedWidth
      finalHeight = options.fixedHeight
    } else {
      // Calculate responsive size and position
      const { width: responsiveWidth, height: responsiveHeight } = calculateResponsiveSize(
        options.width, 
        options.height
      )
      finalWidth = responsiveWidth
      finalHeight = responsiveHeight
    }
    
    const { x: responsiveX, y: responsiveY } = calculateResponsivePosition(
      options.x, 
      options.y, 
      finalWidth, 
      finalHeight,
      windows.value.length
    )

    // Create new window
    const windowId = `window-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const newWindow: WindowState = {
      id: windowId,
      title,
      route,
      x: responsiveX,
      y: responsiveY,
      width: finalWidth,
      height: finalHeight,
      isMinimized: false,
      isMaximized: false,
      zIndex: getNextZIndex(),
      isVisible: true,
      // Set resizing properties
      isResizable: options.isResizable !== undefined ? options.isResizable : true, // Default to resizable
      fixedWidth: options.fixedWidth,
      fixedHeight: options.fixedHeight
    }

    windows.value.push(newWindow)
    return windowId
  }

  const closeWindow = (windowId: string): void => {
    const index = windows.value.findIndex(w => w.id === windowId)
    if (index !== -1) {
      windows.value.splice(index, 1)
    }
  }

  const minimizeWindow = (windowId: string): void => {
    const index = windows.value.findIndex(w => w.id === windowId)
    if (index !== -1) {
      windows.value[index] = {
        ...windows.value[index],
        isMinimized: true
      }
    }
  }

  const restoreWindow = (windowId: string): void => {
    const index = windows.value.findIndex(w => w.id === windowId)
    if (index !== -1) {
      const window = windows.value[index]
      if (window.originalPosition) {
        // Start restore animation
        restoreWindowWithAnimation(windowId, window.originalPosition)
      } else {
        // Fallback if no original position stored
        windows.value[index] = {
          ...window,
          isMinimized: false,
          zIndex: getNextZIndex() // Bring to front
        }
      }
    }
  }

  const restoreWindowWithAnimation = (windowId: string, originalPosition: { x: number, y: number, width: number, height: number }): void => {
    const index = windows.value.findIndex(w => w.id === windowId)
    if (index === -1) return

    const windowState = windows.value[index]
    
    // Use current dock position where the window is actually located
    const dockPosition = getCurrentDockPositionForWindow(windowId)
    
    // Start animation
    windows.value[index] = {
      ...windowState,
      isAnimating: true,
      animationProgress: 0,
      animationOutlines: []
    }

    // Animation duration in milliseconds (faster for better responsiveness)
    const duration = 250
    const startTime = Date.now()
    
    // Number of outline frames to create during animation
    const outlineCount = 6
    
    const animate = () => {
      const elapsed = Date.now() - startTime
      const progress = Math.min(elapsed / duration, 1)
      
      // Smooth easing for better feel
      const easeOut = progress
      
      // Calculate current position and size (reverse of minimize)
      const currentX = dockPosition.x + (originalPosition.x - dockPosition.x) * easeOut
      const currentY = dockPosition.y + (originalPosition.y - dockPosition.y) * easeOut
      const currentWidth = 60 + (originalPosition.width - 60) * easeOut // From dock size to original
      const currentHeight = 60 + (originalPosition.height - 60) * easeOut // From dock size to original

      // Create trail of outlines
      const outlines = []
      for (let i = 0; i < outlineCount; i++) {
        const outlineProgress = Math.max(0, easeOut - (i * 0.15)) // Adjusted gaps
        if (outlineProgress > 0) {
          const outlineX = dockPosition.x + (originalPosition.x - dockPosition.x) * outlineProgress
          const outlineY = dockPosition.y + (originalPosition.y - dockPosition.y) * outlineProgress
          const outlineWidth = 60 + (originalPosition.width - 60) * outlineProgress
          const outlineHeight = 60 + (originalPosition.height - 60) * outlineProgress
          const outlineOpacity = Math.max(0, 1 - (i * 0.25)) // Faster fade out
          
          outlines.push({
            x: outlineX,
            y: outlineY,
            width: outlineWidth,
            height: outlineHeight,
            opacity: outlineOpacity
          })
        }
      }

      // Update window state
      windows.value[index] = {
        ...windows.value[index],
        x: currentX,
        y: currentY,
        width: currentWidth,
        height: currentHeight,
        animationProgress: easeOut,
        animationOutlines: outlines
      }

      if (progress < 1) {
        // Use requestAnimationFrame for smoother animation
        requestAnimationFrame(animate)
      } else {
        // Animation complete
        windows.value[index] = {
          ...windows.value[index],
          isMinimized: false,
          isAnimating: false,
          animationProgress: 1,
          animationOutlines: [],
          zIndex: getNextZIndex() // Bring to front
        }
      }
    }

    requestAnimationFrame(animate) // Start with smooth timing
  }

  const setDockPosition = (position: { x: number, y: number }) => {
    dockPosition.value = position
  }



  const getCurrentDockPositionForWindow = (windowId: string): { x: number, y: number } => {
    // Find the minimized window in the dock
    const minimizedWindows = windows.value.filter(w => w.isMinimized)
    const windowIndex = minimizedWindows.findIndex(w => w.id === windowId)
    
    if (windowIndex === -1) {
      // Fallback to default dock position
      return { x: 600, y: 700 }
    }
    
    // Calculate dock position based on current window index
    const dockElement = document.querySelector('.dock')
    if (dockElement) {
      const dockContainer = dockElement.querySelector('.dock-container')
      
      if (dockContainer) {
        const containerRect = dockContainer.getBoundingClientRect()
        const itemWidth = 60 // Approximate dock item width
        const itemSpacing = 8 // Gap between items
        
        // Calculate position within the dock
        const totalWidth = minimizedWindows.length * (itemWidth + itemSpacing) - itemSpacing
        const startX = containerRect.left + (containerRect.width - totalWidth) / 2
        const itemX = startX + windowIndex * (itemWidth + itemSpacing)
        const itemY = containerRect.top + 20 // Top of dock area
        
        return { x: itemX, y: itemY }
      }
    }
    
    // Fallback to default position
    return { x: 600, y: 700 }
  }

  const minimizeWindowWithAnimation = (windowId: string, targetDockPosition?: { x: number, y: number }): void => {
    const index = windows.value.findIndex(w => w.id === windowId)
    if (index === -1) return

    const windowState = windows.value[index]
    
    // Use provided dock position or fallback to center bottom
    const finalDockPosition = targetDockPosition || {
      x: 600, // Default center
      y: 700  // Default bottom
    }
    
    // Store original position and size
    const originalPosition = {
      x: windowState.x,
      y: windowState.y,
      width: windowState.width,
      height: windowState.height
    }
    
    // Start animation
    windows.value[index] = {
      ...windowState,
      isAnimating: true,
      isMinimized: true,
      animationProgress: 0,
      originalPosition,
      dockPosition: finalDockPosition,
      animationOutlines: []
    }

    // Animation duration in milliseconds (faster for better responsiveness)
    const duration = 250
    const startTime = Date.now()
    
    // Number of outline frames to create during animation
    const outlineCount = 6
    
    const animate = () => {
      const elapsed = Date.now() - startTime
      const progress = Math.min(elapsed / duration, 1)
      
      // Smooth easing for better feel
      const easeOut = progress
      
      // Calculate current position and size
      const currentX = originalPosition.x + (finalDockPosition.x - originalPosition.x) * easeOut
      const currentY = originalPosition.y + (finalDockPosition.y - originalPosition.y) * easeOut
      const currentWidth = originalPosition.width + (60 - originalPosition.width) * easeOut // Dock item width
      const currentHeight = originalPosition.height + (60 - originalPosition.height) * easeOut // Dock item height

      // Create trail of outlines
      const outlines = []
      for (let i = 0; i < outlineCount; i++) {
        const outlineProgress = Math.max(0, easeOut - (i * 0.15)) // Adjusted gaps
        if (outlineProgress > 0) {
          const outlineX = originalPosition.x + (finalDockPosition.x - originalPosition.x) * outlineProgress
          const outlineY = originalPosition.y + (finalDockPosition.y - originalPosition.y) * outlineProgress
          const outlineWidth = originalPosition.width + (60 - originalPosition.width) * outlineProgress
          const outlineHeight = originalPosition.height + (60 - originalPosition.height) * outlineProgress
          const outlineOpacity = Math.max(0, 1 - (i * 0.25)) // Faster fade out
          
          outlines.push({
            x: outlineX,
            y: outlineY,
            width: outlineWidth,
            height: outlineHeight,
            opacity: outlineOpacity
          })
        }
      }

      // Update window state
      windows.value[index] = {
        ...windows.value[index],
        x: currentX,
        y: currentY,
        width: currentWidth,
        height: currentHeight,
        animationProgress: easeOut,
        animationOutlines: outlines
      }

      if (progress < 1) {
        // Use requestAnimationFrame for smoother animation
        requestAnimationFrame(animate)
      } else {
        // Animation complete
        windows.value[index] = {
          ...windows.value[index],
          isMinimized: true,
          isAnimating: false,
          animationProgress: 1,
          animationOutlines: []
        }
      }
    }

    requestAnimationFrame(animate) // Start with smooth timing
  }

  const maximizeWindow = (windowId: string): void => {
    const index = windows.value.findIndex(w => w.id === windowId)
    if (index !== -1) {
      windows.value[index] = {
        ...windows.value[index],
        isMaximized: !windows.value[index].isMaximized
      }
    }
  }

  const bringToFront = (windowId: string): void => {
    const index = windows.value.findIndex(w => w.id === windowId)
    if (index !== -1) {
      windows.value[index] = {
        ...windows.value[index],
        zIndex: getNextZIndex()
      }
    }
  }

  const updateWindowPosition = (windowId: string, x: number, y: number): void => {
    const index = windows.value.findIndex(w => w.id === windowId)
    if (index !== -1) {
      const currentWindow = windows.value[index]
      
      // Use responsive positioning to ensure window stays within bounds
      const { x: responsiveX, y: responsiveY } = calculateResponsivePosition(
        x, 
        y, 
        currentWindow.width, 
        currentWindow.height
      )
      
      // Only update if position actually changed
      if (currentWindow.x !== responsiveX || currentWindow.y !== responsiveY) {
        // Update properties directly for better performance
        currentWindow.x = responsiveX
        currentWindow.y = responsiveY
        // Trigger reactivity by reassigning the array
        windows.value = [...windows.value]
      }
    }
  }

  // Ensure all windows are within screen bounds (useful for screen resize)
  const ensureWindowsInBounds = (): void => {
    windows.value.forEach((window, index) => {
      const { x: responsiveX, y: responsiveY } = calculateResponsivePosition(
        window.x, 
        window.y, 
        window.width, 
        window.height
      )
      
      if (window.x !== responsiveX || window.y !== responsiveY) {
        windows.value[index] = {
          ...window,
          x: responsiveX,
          y: responsiveY
        }
      }
    })
  }

  const updateWindowSize = (windowId: string, width: number, height: number): void => {
    const index = windows.value.findIndex(w => w.id === windowId)
    if (index !== -1) {
      const currentWindow = windows.value[index]
      // Only update if size actually changed
      if (currentWindow.width !== width || currentWindow.height !== height) {
        // Update properties directly for better performance
        currentWindow.width = width
        currentWindow.height = height
        // Trigger reactivity by reassigning the array
        windows.value = [...windows.value]
      }
    }
  }

  const getVisibleWindows = (): WindowState[] => {
    return windows.value.filter(w => w.isVisible && !w.isMinimized)
  }

  const getWindowByRoute = (route: string): WindowState | undefined => {
    return windows.value.find(w => w.route === route)
  }

  return {
    windows,
    dockPosition,
    openWindow,
    closeWindow,
    minimizeWindow,
    restoreWindow,
    minimizeWindowWithAnimation,
    setDockPosition,
    maximizeWindow,
    bringToFront,
    updateWindowPosition,
    updateWindowSize,
    getVisibleWindows,
    getWindowByRoute,
    smoothUpdateSize,
    ensureWindowsInBounds,
    // Utility functions
    getViewportBounds
  }
} 