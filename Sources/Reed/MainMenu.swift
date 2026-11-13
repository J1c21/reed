import AppKit

/// The menu bar. Notebook commands are forwarded to the page by id; their key equivalents
/// are shown here, but the page sees key presses first and handles them itself.
///
/// The app is meant to be worked from the keyboard, so the menu bar doubles as the place to
/// look a shortcut up: every command with a ⌘ key shows it here. (Single-letter command-mode
/// keys are not key equivalents — AppKit would take them from the text being typed — and are
/// listed in Help ▸ Keyboard Shortcuts instead.)
enum MainMenu {
    private static let web = #selector(NotebookWindowController.performWebCommand(_:))

    private static func item(_ title: String, _ action: Selector?, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        return item
    }

    /// A menu item that runs a notebook command.
    private static func command(_ title: String, _ id: String, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let item = item(title, web, key, modifiers)
        item.representedObject = id
        return item
    }

    private static func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
        let menu = NSMenu(title: title)
        items.forEach(menu.addItem)
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }

    private static var separator: NSMenuItem { .separator() }

    private static let up = String(UnicodeScalar(NSUpArrowFunctionKey)!)
    private static let down = String(UnicodeScalar(NSDownArrowFunctionKey)!)

    static func build(delegate: AppDelegate) -> NSMenu {
        let main = NSMenu()

        // ── Reed ──
        let services = NSMenu(title: "Services")
        NSApp.servicesMenu = services
        let servicesItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        servicesItem.submenu = services
        let about = item("About Reed", #selector(AppDelegate.showAbout(_:)))
        about.target = delegate
        main.addItem(submenu("Reed", [
            about,
            separator,
            // Every preference is in one list (the palette's), not spread over the menus.
            command("Settings…", "app.settings", ","),
            separator,
            servicesItem,
            separator,
            item("Hide Reed", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            separator,
            item("Quit Reed", #selector(NSApplication.terminate(_:)), "q"),
        ]))

        // ── File ──
        let new = item("New Notebook", #selector(AppDelegate.newDocument(_:)), "n")
        new.target = delegate
        let open = item("Open…", #selector(AppDelegate.openDocument(_:)), "o")
        open.target = delegate
        let recent = submenu("Open Recent", [])
        delegate.adoptRecentMenu(recent.submenu!)
        main.addItem(submenu("File", [
            new,
            open,
            command("Open Quickly…", "file.openQuickly", "o", [.command, .shift]),
            recent,
            separator,
            item("Close", #selector(NSWindow.performClose(_:)), "w"),
            command("Save", "file.save", "s"),
            command("Save As…", "file.saveAs", "s", [.command, .shift]),
            command("Rename…", "file.rename"),
            separator,
            submenu("Export", [
                command("Script…", "file.exportScript"),
                command("Markdown…", "file.exportMarkdown"),
            ]),
            separator,
            command("Reveal in Finder", "file.reveal"),
        ]))

        // ── Edit ──
        main.addItem(submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            separator,
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Delete", #selector(NSText.delete(_:))),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
            separator,
            command("Copy Cell Output", "cell.copyOutput"),
            separator,
            command("Show Completions", "edit.complete", "\u{1b}", [.option]),
            separator,
            command("Find…", "edit.find", "f"),
            command("Find Next", "edit.findNext", "g"),
            command("Find Previous", "edit.findPrevious", "g", [.command, .shift]),
            separator,
            command("Undo Cell Operation", "edit.undoCells"),
            command("Redo Cell Operation", "edit.redoCells"),
        ]))

        // ── View ──
        let fullScreen = item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
        main.addItem(submenu("View", [
            command("Command Palette…", "view.palette", "k"),
            command("Go to Heading…", "go.heading", "j"),
            command("Variables…", "go.variables", "v", [.command, .option]),
            separator,
            command("Focus Mode", "view.focusMode", String(UnicodeScalar(NSF8FunctionKey)!), []),
            command("Typewriter Mode", "view.typewriter", String(UnicodeScalar(NSF9FunctionKey)!), []),
            separator,
            command("Zoom In", "view.zoomIn", "+"),
            command("Zoom Out", "view.zoomOut", "-"),
            command("Actual Size", "view.zoomReset", "0"),
            separator,
            fullScreen,
        ]))

        // ── Cell ──
        main.addItem(submenu("Cell", [
            command("Insert Code Cell Above", "cell.insertAbove"),
            command("Insert Code Cell Below", "cell.insertBelow"),
            command("Insert Markdown Cell Below", "cell.insertMarkdownBelow"),
            separator,
            command("Change to Code", "cell.toCode", "y", [.command, .shift]),
            command("Change to Markdown", "cell.toMarkdown", "m", [.command, .shift]),
            separator,
            command("Move Up", "cell.moveUp", up, [.control, .shift]),
            command("Move Down", "cell.moveDown", down, [.control, .shift]),
            command("Split at Cursor", "cell.split", "-", [.control, .shift]),
            command("Merge with Cell Below", "cell.merge"),
            command("Duplicate", "cell.duplicate"),
            separator,
            command("Cut Cell", "cell.cut"),
            command("Copy Cell", "cell.copy"),
            command("Paste Cell Below", "cell.paste"),
            separator,
            command("Hide or Show Code", "cell.toggleCode"),
            command("Hide or Show Output", "cell.toggleOutput"),
            command("Clear Output", "cell.clearOutput"),
            command("Clear All Outputs", "notebook.clearOutputs"),
            separator,
            command("Delete Cell", "cell.delete"),
        ]))

        // ── Run ──
        main.addItem(submenu("Run", [
            command("Run Cell", "cell.run", "\r"),
            command("Run Cell and Select Next", "cell.runAndAdvance", "\r", [.shift]),
            command("Run Cell and Insert Below", "cell.runAndInsert", "\r", [.option]),
            separator,
            command("Run All", "notebook.runAll", "\r", [.command, .shift]),
            command("Run All Above", "cell.runAbove"),
            command("Run Cell and All Below", "cell.runBelow"),
            command("Run Stale Cells", "notebook.runStale"),
            separator,
            command("Reactive Execution", "view.reactive"),
        ]))

        // ── Kernel ──
        main.addItem(submenu("Kernel", [
            command("Select Kernel…", "kernel.pick", "k", [.command, .option]),
            separator,
            command("Interrupt", "kernel.interrupt", "."),
            command("Restart", "kernel.restart"),
            command("Restart and Run All", "kernel.restartRunAll"),
            command("Restart and Clear Outputs", "kernel.restartClear"),
            separator,
            command("Shut Down", "kernel.shutdown"),
        ]))

        // ── Window ──
        let windowMenu = submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            separator,
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ])
        NSApp.windowsMenu = windowMenu.submenu
        main.addItem(windowMenu)

        // ── Help ──
        let helpMenu = submenu("Help", [
            command("Keyboard Shortcuts", "help.shortcuts", String(UnicodeScalar(NSF1FunctionKey)!), []),
        ])
        NSApp.helpMenu = helpMenu.submenu
        main.addItem(helpMenu)

        return main
    }
}
