package ru.foodflow.pos.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.viewmodel.compose.viewModel
import ru.foodflow.pos.ui.screens.JournalScreen
import ru.foodflow.pos.ui.screens.LoginScreen
import ru.foodflow.pos.ui.screens.PosScreen
import ru.foodflow.pos.ui.screens.SettingsScreen
import ru.foodflow.pos.ui.screens.SetupScreen
import ru.foodflow.pos.ui.screens.ShiftScreen

/** Палитра FoodFlow: тёмный интерфейс, зелёный акцент. */
private val FoodFlowColors = darkColorScheme(
    primary = Color(0xFF1F9254),
    onPrimary = Color.White,
    secondary = Color(0xFF2E7D32),
    background = Color(0xFF14171C),
    surface = Color(0xFF1C2026),
    onSurface = Color(0xFFE8EAED),
    surfaceVariant = Color(0xFF262B33),
    onSurfaceVariant = Color(0xFFB3B8C0),
    error = Color(0xFFCF5B5B)
)

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = FoodFlowColors) {
                Surface(modifier = Modifier.fillMaxSize()) {
                    PosApp()
                }
            }
        }
    }
}

@Composable
private fun PosApp(vm: PosViewModel = viewModel()) {
    val screen by vm.screen.collectAsState()
    val toast by vm.toast.collectAsState()
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(toast) {
        toast?.let {
            snackbar.showSnackbar(it)
            vm.consumeToast()
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) }
    ) { padding ->
        Box(Modifier.fillMaxSize()) {
            when (screen) {
                Screen.SETUP -> SetupScreen(vm, padding)
                Screen.LOGIN -> LoginScreen(vm, padding)
                Screen.POS -> PosScreen(vm, padding)
                Screen.JOURNAL -> JournalScreen(vm, padding)
                Screen.SHIFT -> ShiftScreen(vm, padding)
                Screen.SETTINGS -> SettingsScreen(vm, padding)
            }
        }
    }
}
