package com.example.hello

import android.os.Bundle
import com.example.hello.databinding.ActivityMainBinding
import com.ffalcon.mercury.android.sdk.ui.activity.BaseMirrorActivity

class MainActivity : BaseMirrorActivity<ActivityMainBinding>() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        mBindingPair.updateView {
        }
    }
}