package dev.whatsup.app

import android.Manifest
import android.content.res.ColorStateList
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.core.widget.doAfterTextChanged
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * The settings screen, as sections of cards: location (the phone's, or one set by hand), map style
 * (a grid of previews), satellites (a card per
 * SatelliteCategory, folding open to its groups), display layers, alerts, and about. Built in code
 * from small row layouts, since the groups, layers and tile sets are all lists defined elsewhere.
 */
class SettingsActivity : ComponentActivity() {
    private lateinit var settings: Settings
    private lateinit var content: LinearLayout
    /** Categories folded open; kept across rotation. */
    private val expanded = mutableSetOf<SatelliteCategory>()
    private var alertSwitches: List<Switch> = emptyList()

    /** Turning an alert on asks to notify; if refused, the alerts go back off. */
    private val requestNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) {
            alertSwitches.forEach { it.isChecked = false }
            Toast.makeText(this, R.string.pass_alerts_denied, Toast.LENGTH_LONG).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        settings = Settings(this)
        content = findViewById(R.id.content)
        findViewById<View>(R.id.back).setOnClickListener { finish() }

        val saved = savedInstanceState?.getStringArrayList(KEY_EXPANDED)
        expanded += saved?.mapNotNull { name -> SatelliteCategory.entries.find { it.name == name } }
            // At first, open the categories with something switched on, so the user sees what is shown.
            ?: SatelliteCategory.entries.filter { category -> category.groups.any(settings::isShown) }

        addLocation()
        addOffline()
        addMapStyles()
        addSatellites()
        addDisplay()
        addAircraft()
        addAlerts()
        addAbout()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putStringArrayList(KEY_EXPANDED, ArrayList(expanded.map { it.name }))
    }

    // ---- Sections ----

    /**
     * The phone's location, or one set by hand: typed as an address, latitude and longitude, or
     * MGRS, found (Places), then shown in all three forms to check.
     */
    private fun addLocation() {
        addSectionHeader(R.drawable.ic_my_location, R.string.section_location)
        val card = addCard()
        val result = TextView(this)
        // The switch's description says which location is in use, so it changes with it.
        lateinit var source: TextView
        lateinit var manual: Switch
        manual = addSwitchRow(card, getString(R.string.manual_location), describeLocationSource(), settings.useManualLocation) { on ->
            if (on && settings.manualLocation == null) {
                manual.isChecked = false
                result.text = getString(R.string.manual_location_first)
                return@addSwitchRow
            }
            settings.useManualLocation = on
            source.text = describeLocationSource()
        }
        source = card.getChildAt(card.childCount - 1).findViewById(R.id.row_subtitle)
        addDivider(card)

        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = android.view.Gravity.CENTER_VERTICAL
        row.setPadding(dp(16), dp(10), dp(12), dp(4))
        val input = android.widget.EditText(this)
        input.hint = getString(R.string.manual_location_hint)
        input.setSingleLine()
        input.textSize = 15f
        input.setTextColor(getColor(android.R.color.white))
        input.setHintTextColor(getColor(R.color.text_secondary))
        input.imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH
        input.backgroundTintList = ColorStateList.valueOf(getColor(R.color.accent))
        val find = android.widget.Button(this)
        find.text = getString(R.string.manual_location_find)
        find.isAllCaps = false
        row.addView(input, LinearLayout.LayoutParams(0, WRAP, 1f))
        row.addView(find, LinearLayout.LayoutParams(WRAP, WRAP).apply { marginStart = dp(8) })
        card.addView(row)

        result.setTextColor(getColor(R.color.text_secondary))
        result.textSize = 13f
        result.setLineSpacing(0f, 1.2f)
        result.setPadding(dp(16), dp(4), dp(16), dp(14))
        result.setTextIsSelectable(true)
        settings.manualLocation?.let { result.text = describePlace(it) }
        card.addView(result)

        // One lookup at a time: a new one (other text) replaces one still running, so the place kept
        // is always the latest asked for.
        var lookup: kotlinx.coroutines.Job? = null
        val search = {
            val text = input.text.toString()
            if (text.isNotBlank()) {
                lookup?.cancel()
                result.text = getString(R.string.manual_location_looking)
                lookup = lifecycleScope.launch {
                    val place = Places.find(this@SettingsActivity, text)
                    if (place == null) {
                        result.text = getString(
                            if (settings.offlineMode) R.string.manual_location_not_found_offline else R.string.manual_location_not_found,
                            text.trim(),
                        )
                        return@launch
                    }
                    settings.manualLocation = place
                    settings.useManualLocation = true
                    manual.isChecked = true
                    source.text = describeLocationSource()
                    result.text = describePlace(place)
                }
            }
        }
        find.setOnClickListener { search() }
        input.setOnEditorActionListener { _, actionId, event ->
            // The keyboard's search key; or Enter on a hardware keyboard, which also sends a key-up
            // that must not search a second time.
            val enter = event?.keyCode == android.view.KeyEvent.KEYCODE_ENTER
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH ||
                (enter && event?.action == android.view.KeyEvent.ACTION_DOWN)
            ) {
                search()
                true
            } else {
                enter
            }
        }
    }

    private fun describeLocationSource(): String {
        val place = settings.activeManualLocation ?: return getString(R.string.manual_location_off)
        return getString(R.string.manual_location_on, place.label.ifEmpty { place.position.format() })
    }

    /** A found place in every form: its name, latitude and longitude, and MGRS. */
    private fun describePlace(place: Place): String {
        val how = getString(
            when (place.source) {
                Place.Source.COORDINATES -> R.string.manual_location_from_coordinates
                Place.Source.MGRS -> R.string.manual_location_from_mgrs
                Place.Source.ADDRESS -> R.string.manual_location_from_address
            },
        )
        val mgrs = Coordinates.toMgrs(place.position)
        return listOfNotNull(
            "✓ $how: ${place.label}",
            getString(R.string.manual_location_lat_lon, place.position.format()),
            mgrs?.let { getString(R.string.manual_location_mgrs, it) },
        ).joinToString("\n")
    }

    private fun addMapStyles() {
        addSectionHeader(R.drawable.ic_map, R.string.section_map)
        val choices = mutableListOf<View>()
        TileSets.all.chunked(2).forEach { pair ->
            val row = LinearLayout(this)
            row.orientation = LinearLayout.HORIZONTAL
            pair.forEachIndexed { i, tileSet ->
                val card = inflate(R.layout.item_tile_choice, row)
                (card.layoutParams as LinearLayout.LayoutParams).apply {
                    if (i == 1) marginStart = dp(12)
                }
                card.findViewById<TextView>(R.id.tile_name).text = tileSet.name
                card.findViewById<TextView>(R.id.tile_description).text = tileSet.description
                card.isSelected = tileSet == settings.tileSet
                card.contentDescription = tileSet.name
                card.setOnClickListener {
                    settings.tileSet = tileSet
                    choices.forEach { it.isSelected = it === card }
                }
                val preview = card.findViewById<ImageView>(R.id.tile_preview)
                preview.clipToOutline = true
                lifecycleScope.launch { TilePreviews.load(this@SettingsActivity, tileSet)?.let(preview::setImageBitmap) }
                choices += card
                row.addView(card)
            }
            // An odd last tile set keeps half the width, like the others.
            if (pair.size == 1) row.addView(View(this), LinearLayout.LayoutParams(0, 0, 1f).apply { marginStart = dp(12) })
            content.addView(row, LinearLayout.LayoutParams(MATCH, WRAP).apply { if (content.childCount > 1) topMargin = dp(12) })
        }
    }

    private fun addSatellites() {
        addSectionHeader(R.drawable.ic_globe, R.string.section_satellites)
        SatelliteCategory.entries.forEachIndexed { i, category ->
            val card = addCard(topMargin = if (i == 0) 0 else dp(10))
            addCategory(card, category)
        }
    }

    /** A category's header and, while it is open, a row per group. */
    private fun addCategory(card: LinearLayout, category: SatelliteCategory) {
        val header = inflate(R.layout.item_category_header, card)
        card.addView(header)
        val title = getString(category.title)
        header.findViewById<TextView>(R.id.category_title).text = title
        val dots = header.findViewById<LinearLayout>(R.id.category_dots)
        for (group in category.groups.take(MAX_HEADER_DOTS)) {
            val dot = View(this)
            dot.setBackgroundResource(R.drawable.dot)
            dot.backgroundTintList = ColorStateList.valueOf(OPAQUE or group.color)
            dots.addView(dot, LinearLayout.LayoutParams(dp(8), dp(8)).apply { marginEnd = dp(3) })
        }
        val chevron = header.findViewById<ImageView>(R.id.category_chevron)
        val summary = header.findViewById<TextView>(R.id.category_summary)
        val all = header.findViewById<TextView>(R.id.category_all)
        all.contentDescription = getString(R.string.category_toggle_description, title)

        val rows = LinearLayout(this)
        rows.orientation = LinearLayout.VERTICAL
        card.addView(rows)
        val switches = category.groups.map { group ->
            addDivider(rows)
            val (groupTitle, description) = splitTitle(getString(group.title))
            addSwitchRow(rows, groupTitle, description, settings.isShown(group), group.color) { on ->
                settings.setShown(group, on)
                updateSummary(summary, category)
            }
        }
        // One switch: no need for "All".
        all.visibility = if (category.groups.size > 1) View.VISIBLE else View.GONE
        all.setOnClickListener {
            // Everything on unless it already is; then everything off.
            val on = !category.groups.all(settings::isShown)
            switches.forEach { it.isChecked = on }
        }

        fun showOpen() {
            val open = category in expanded
            rows.visibility = if (open) View.VISIBLE else View.GONE
            chevron.rotation = if (open) 180f else 0f
        }
        header.setOnClickListener {
            if (!expanded.remove(category)) expanded += category
            showOpen()
        }
        showOpen()
        updateSummary(summary, category)
    }

    private fun updateSummary(summary: TextView, category: SatelliteCategory) {
        val on = category.groups.count(settings::isShown)
        val total = category.groups.size
        summary.text = when (on) {
            0 -> getString(R.string.category_summary_none)
            total -> getString(R.string.category_summary_all)
            else -> getString(R.string.category_summary, on, total)
        }
    }

    private fun addDisplay() {
        addSectionHeader(R.drawable.ic_layers, R.string.section_display)
        val card = addCard()
        DisplayLayer.entries.forEachIndexed { i, layer ->
            if (i > 0) addDivider(card)
            val (title, description) = splitTitle(getString(layer.title))
            addSwitchRow(card, title, description, settings.isShown(layer)) { settings.setShown(layer, it) }
        }
    }

    /**
     * Live aircraft (AircraftFeed): on or off, how far around the location, and optionally the
     * user's own receiver.
     */
    private fun addAircraft() {
        addSectionHeader(R.drawable.ic_aircraft, R.string.section_aircraft)
        val card = addCard()
        val (title, description) = splitTitle(getString(R.string.aircraft_shown))
        addSwitchRow(card, title, description, settings.aircraftShown) { settings.aircraftShown = it }
        addDivider(card)

        val radius = TextView(this)
        radius.setTextColor(getColor(android.R.color.white))
        radius.textSize = 15f
        radius.setPadding(dp(16), dp(12), dp(16), 0)
        val usage = TextView(this)
        usage.setTextColor(getColor(R.color.text_secondary))
        usage.textSize = 13f
        usage.setPadding(dp(16), 0, dp(16), dp(12))
        val slider = android.widget.SeekBar(this)
        // In steps of 5 NM.
        slider.max = (AircraftFeed.MAX_RADIUS_NM - AircraftFeed.MIN_RADIUS_NM) / RADIUS_STEP_NM
        slider.progress = (settings.aircraftRadiusNm - AircraftFeed.MIN_RADIUS_NM) / RADIUS_STEP_NM
        slider.progressTintList = ColorStateList.valueOf(getColor(R.color.accent))
        slider.thumbTintList = ColorStateList.valueOf(getColor(R.color.accent))
        slider.setPadding(dp(16), dp(8), dp(16), dp(8))
        val show = { nm: Int ->
            radius.text = getString(R.string.aircraft_radius, nm, Math.round(nm * 1.852))
            usage.text = getString(R.string.aircraft_radius_note)
        }
        show(settings.aircraftRadiusNm)
        slider.setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: android.widget.SeekBar, progress: Int, fromUser: Boolean) {
                val nm = AircraftFeed.MIN_RADIUS_NM + progress * RADIUS_STEP_NM
                settings.aircraftRadiusNm = nm
                show(nm)
            }
            override fun onStartTrackingTouch(bar: android.widget.SeekBar) {}
            override fun onStopTrackingTouch(bar: android.widget.SeekBar) {}
        })
        card.addView(radius)
        card.addView(slider, LinearLayout.LayoutParams(MATCH, WRAP))
        card.addView(usage)
        addDivider(card)

        val receiverTitle = TextView(this)
        receiverTitle.text = getString(R.string.aircraft_receiver)
        receiverTitle.setTextColor(getColor(android.R.color.white))
        receiverTitle.textSize = 15f
        receiverTitle.setPadding(dp(16), dp(12), dp(16), 0)
        val receiver = android.widget.EditText(this)
        receiver.hint = getString(R.string.aircraft_receiver_hint)
        receiver.setText(settings.aircraftReceiver)
        receiver.setSingleLine()
        receiver.textSize = 14f
        receiver.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
        receiver.setTextColor(getColor(android.R.color.white))
        receiver.setHintTextColor(getColor(R.color.text_secondary))
        receiver.backgroundTintList = ColorStateList.valueOf(getColor(R.color.accent))
        receiver.doAfterTextChanged { settings.aircraftReceiver = it?.toString().orEmpty() }
        val receiverNote = TextView(this)
        receiverNote.text = getString(R.string.aircraft_receiver_note)
        receiverNote.setTextColor(getColor(R.color.text_secondary))
        receiverNote.textSize = 13f
        receiverNote.setLineSpacing(0f, 1.2f)
        receiverNote.setPadding(dp(16), 0, dp(16), dp(14))
        card.addView(receiverTitle)
        card.addView(receiver, LinearLayout.LayoutParams(MATCH, WRAP).apply { marginStart = dp(12); marginEnd = dp(12) })
        card.addView(receiverNote)
    }

    /** Offline mode: the app uses only what it has saved (see Settings.offlineMode). */
    private fun addOffline() {
        addSectionHeader(R.drawable.ic_globe, R.string.section_data)
        val card = addCard()
        val (title, description) = splitTitle(getString(R.string.offline_mode))
        addSwitchRow(card, title, description, settings.offlineMode) { settings.offlineMode = it }
    }

    private fun addAlerts() {
        addSectionHeader(R.drawable.ic_bell, R.string.section_alerts)
        val card = addCard()
        val (title, description) = splitTitle(getString(R.string.pass_alerts))
        val issSwitch = addSwitchRow(card, title, description, settings.passAlerts) { on ->
            settings.passAlerts = on
            alertsChanged(on)
        }
        addDivider(card)
        val (favouriteTitle, favouriteDescription) = splitTitle(getString(R.string.favourite_alerts))
        val favouriteSwitch = addSwitchRow(card, favouriteTitle, favouriteDescription, settings.favouriteAlerts) { on ->
            settings.favouriteAlerts = on
            alertsChanged(on)
        }
        alertSwitches = listOf(issSwitch, favouriteSwitch)
    }

    /** Turning an alert on asks to notify, if the app may not yet; then the alarms are set again. */
    private fun alertsChanged(on: Boolean) {
        if (on && !PassAlerts.canNotify(this) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        PassAlerts.reschedule(this)
    }

    private fun addAbout() {
        addSectionHeader(R.drawable.ic_info, R.string.section_about)
        val card = addCard()
        val text = TextView(this)
        text.text = getString(R.string.about_version, BuildConfig.VERSION_NAME) + "\n\n" + getString(R.string.about_text)
        text.setTextColor(getColor(R.color.text_secondary))
        text.textSize = 13f
        text.setLineSpacing(0f, 1.2f)
        text.setPadding(dp(16), dp(14), dp(16), dp(14))
        card.addView(text)
    }

    // ---- Building blocks ----

    private fun addSectionHeader(@DrawableRes icon: Int, @StringRes title: Int) {
        val header = inflate(R.layout.item_section_header, content)
        header.findViewById<ImageView>(R.id.section_icon).setImageResource(icon)
        header.findViewById<TextView>(R.id.section_title).setText(title)
        content.addView(header)
    }

    /** A rounded card for rows, added to the page. */
    private fun addCard(topMargin: Int = 0): LinearLayout {
        val card = LinearLayout(this)
        card.orientation = LinearLayout.VERTICAL
        card.setBackgroundResource(R.drawable.card_bg)
        // Row ripples stay inside the rounded corners.
        card.clipToOutline = true
        content.addView(card, LinearLayout.LayoutParams(MATCH, WRAP).apply { this.topMargin = topMargin })
        return card
    }

    private fun addDivider(parent: LinearLayout) {
        val divider = View(this)
        divider.setBackgroundColor(getColor(R.color.card_stroke))
        parent.addView(divider, LinearLayout.LayoutParams(MATCH, 1).apply { marginStart = dp(16) })
    }

    /** A row with title, description and switch; tapping anywhere on it flips the switch. */
    private fun addSwitchRow(
        parent: LinearLayout,
        title: String,
        description: String,
        checked: Boolean,
        color: Int? = null,
        onChange: (Boolean) -> Unit,
    ): Switch {
        val row = inflate(R.layout.item_setting_row, parent)
        row.findViewById<TextView>(R.id.row_title).text = title
        row.findViewById<TextView>(R.id.row_subtitle).apply {
            text = description
            visibility = if (description.isEmpty()) View.GONE else View.VISIBLE
        }
        if (color != null) {
            row.findViewById<View>(R.id.row_dot).apply {
                visibility = View.VISIBLE
                backgroundTintList = ColorStateList.valueOf(OPAQUE or color)
            }
        }
        val switch = row.findViewById<Switch>(R.id.row_switch)
        switch.isChecked = checked
        switch.contentDescription = title
        switch.setOnCheckedChangeListener { _, isChecked -> onChange(isChecked) }
        row.setOnClickListener { switch.toggle() }
        parent.addView(row)
        return switch
    }

    /** The strings for switches are "Title\nDescription". */
    private fun splitTitle(text: String): Pair<String, String> =
        text.substringBefore('\n') to text.substringAfter('\n', "")

    private fun inflate(layout: Int, parent: ViewGroup): View = layoutInflater.inflate(layout, parent, false)

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val KEY_EXPANDED = "expanded"
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        const val OPAQUE = 0xFF000000.toInt()
        const val MAX_HEADER_DOTS = 5
        const val RADIUS_STEP_NM = 5
    }
}
